import * as vscode from 'vscode';
import type {
	CachedUsage,
	DeviceAuthInitiateResponse,
	DeviceAuthPollResponse,
	QuotaExceededErrorMeta,
	Tier,
	UsageCategory,
	UsageItem,
	UsageResponse,
} from './types';
import { log } from '../logger';
import { canUseTier, getModelTierRequirement } from './types';

const CACHE_DURATION_MS = 5 * 60 * 1000;
const API_KEY_SECRET_KEY = 'deniApiKey';
const POLL_INTERVAL_MS = 5000;
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

function getDeniAiBaseUrl(): string {
	const config = vscode.workspace.getConfiguration('flixa');
	return config.get<string>('deniAiBaseUrl') || 'https://deniai.app';
}

export function getFlixaApiBaseUrl(): string {
	const config = vscode.workspace.getConfiguration('flixa');
	return config.get<string>('flixaApiBaseUrl') || 'https://api.flixa.engineer';
}

export function getBillingUrl(): string {
	return `${getDeniAiBaseUrl()}/settings/billing`;
}

function getCategoryLabel(category: UsageCategory | undefined): string {
	if (category === 'basic') {
		return 'Basic';
	}
	if (category === 'premium') {
		return 'Premium';
	}
	return 'Free';
}

export async function showQuotaExceededDialog(
	error: QuotaExceededErrorMeta,
	onAfterAction?: () => Promise<void>
): Promise<void> {
	const title =
		error.tier === 'free'
			? `${getCategoryLabel(error.category)} limit reached`
			: 'Usage limit reached';
	const message = `${title}: ${error.message}`;
	const canVerify = error.canVerifyForBoost === true;
	const canUpgrade = error.canUpgrade === true;
	const primaryAction = canVerify ? 'Verify card' : canUpgrade ? 'Upgrade' : 'Close';
	const actions = [primaryAction];

	if (canVerify && canUpgrade) {
		actions.push('Upgrade');
	} else if (primaryAction !== 'Close') {
		actions.push('Close');
	}

	const selected = await vscode.window.showErrorMessage(
		message,
		{ modal: true },
		...actions
	);

	if (selected === 'Verify card' && error.verifyUrl) {
		vscode.env.openExternal(vscode.Uri.parse(error.verifyUrl));
	} else if (selected === 'Upgrade' && error.upgradeUrl) {
		vscode.env.openExternal(vscode.Uri.parse(error.upgradeUrl));
	}

	if (onAfterAction) {
		await onAfterAction();
	}
}

function normalizeUsageItem(item: Partial<UsageItem>): UsageItem | null {
	if (
		(item.category !== 'basic' && item.category !== 'premium') ||
		typeof item.limit !== 'number' ||
		typeof item.used !== 'number'
	) {
		return null;
	}

	return {
		category: item.category,
		limit: item.limit,
		used: item.used,
		unit: typeof item.unit === 'string' ? item.unit : 'tokens',
		remaining:
			typeof item.remaining === 'number'
				? item.remaining
				: Math.max(item.limit - item.used, 0),
		periodStart: typeof item.periodStart === 'string' ? item.periodStart : '',
		periodEnd: typeof item.periodEnd === 'string' ? item.periodEnd : '',
	};
}

function normalizeUsageResponse(payload: unknown): UsageResponse {
	const record = payload as Partial<UsageResponse>;
	const usage = Array.isArray(record.usage)
		? record.usage
			.map((item) => normalizeUsageItem(item as Partial<UsageItem>))
			.filter((item): item is UsageItem => !!item)
		: [];

	return {
		tier: record.tier ?? 'free',
		planId: record.planId ?? null,
		status: record.status ?? null,
		periodEnd: record.periodEnd ?? usage[0]?.periodEnd ?? null,
		maxModeEnabled: record.maxModeEnabled ?? false,
		maxModeEligible: record.maxModeEligible ?? false,
		isTeam: record.isTeam ?? false,
		hasVerifiedPaymentMethod: record.hasVerifiedPaymentMethod ?? false,
		cardVerifiedAt: record.cardVerifiedAt ?? null,
		cardFunding: record.cardFunding ?? null,
		verifyUrl: record.verifyUrl ?? null,
		upgradeUrl: record.upgradeUrl ?? null,
		usage,
	};
}

export class UsageService {
	private _context: vscode.ExtensionContext;
	private _cache: CachedUsage | null = null;
	private _onUsageChanged = new vscode.EventEmitter<UsageResponse | null>();
	public readonly onUsageChanged = this._onUsageChanged.event;
	private _lowQuotaWarningShown: Set<UsageCategory> = new Set();

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	async getApiKey(): Promise<string | undefined> {
		return this._context.secrets.get(API_KEY_SECRET_KEY);
	}

	async setApiKey(key: string | undefined): Promise<void> {
		if (key) {
			await this._context.secrets.store(API_KEY_SECRET_KEY, key);
		} else {
			await this._context.secrets.delete(API_KEY_SECRET_KEY);
		}
		this._cache = null;
		this._lowQuotaWarningShown.clear();
		if (key) {
			await this.fetchUsage(true);
		} else {
			this._onUsageChanged.fire(null);
		}
	}

	async logout(): Promise<void> {
		await this.setApiKey(undefined);
	}

	async isLoggedIn(): Promise<boolean> {
		const key = await this.getApiKey();
		return !!key;
	}

	getCachedUsage(): UsageResponse | null {
		if (!this._cache) {
			return null;
		}
		return this._cache.data;
	}

	getTier(): Tier | null {
		const data = this.getCachedUsage();
		return data?.tier ?? null;
	}

	canUseModel(model: string): boolean {
		const tier = this.getTier();
		if (!tier) {
			return false;
		}
		const required = getModelTierRequirement(model);
		return canUseTier(tier, required);
	}

	async fetchUsage(force = false): Promise<UsageResponse | null> {
		const apiKey = await this.getApiKey();
		console.log('[Flixa] fetchUsage - apiKey exists:', !!apiKey);
		if (!apiKey) {
			this._onUsageChanged.fire(null);
			return null;
		}

		if (!force && this._cache) {
			const age = Date.now() - this._cache.fetchedAt;
			if (age < CACHE_DURATION_MS) {
				console.log('[Flixa] fetchUsage - returning cached data');
				return this._cache.data;
			}
		}

		try {
			const apiBaseUrl = getFlixaApiBaseUrl();
			const endpoints = [
				`${apiBaseUrl}/v1/deni/billing-status`,
				`${apiBaseUrl}/v1/deni/usage`,
			];
			let response: Response | null = null;
			for (const endpoint of endpoints) {
				console.log('[Flixa] fetchUsage - fetching from:', endpoint);
				response = await fetch(endpoint, {
					headers: {
						Authorization: `Bearer ${apiKey}`,
					},
				});
				if (response.status !== 404) {
					break;
				}
			}

			console.log('[Flixa] fetchUsage - response status:', response?.status);

			if (response?.status === 401) {
				await this.logout();
				vscode.window.showErrorMessage(
					'Deni AI: API key is invalid or expired. Please log in again.'
				);
				return null;
			}

			if (!response || !response.ok) {
				throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
			}

			const data = normalizeUsageResponse(await response.json());
			console.log('[Flixa] fetchUsage - data:', JSON.stringify(data));
			this._cache = {
				data,
				fetchedAt: Date.now(),
			};
			this._onUsageChanged.fire(data);
			return data;
		} catch (error) {
			console.log('[Flixa] fetchUsage - error:', error);
			if (this._cache) {
				return this._cache.data;
			}
			return null;
		}
	}

	incrementUsage(category: UsageCategory): void {
		if (!this._cache) {
			return;
		}
		const usageItem = this._cache.data.usage.find(
			(u) => u.category === category
		);
		if (usageItem && usageItem.remaining > 0) {
			usageItem.used += 1;
			usageItem.remaining -= 1;
			this._onUsageChanged.fire(this._cache.data);
		}
	}

	async refreshAfterSend(category: UsageCategory): Promise<void> {
		void category;
		setTimeout(() => {
			this.fetchUsage(true);
		}, 1000);
	}

	getUsageForCategory(category: UsageCategory): {
		used: number;
		limit: number;
		remaining: number;
	} | null {
		const data = this.getCachedUsage();
		if (!data) {
			return null;
		}
		const item = data.usage.find((u) => u.category === category);
		if (!item) {
			return null;
		}
		return {
			used: item.used,
			limit: item.limit,
			remaining: item.remaining,
		};
	}

	checkQuotaAndWarn(category: UsageCategory): {
		canProceed: boolean;
		maxModeEnabled: boolean;
		maxModeEligible: boolean;
		remaining: number;
		limit: number;
	} {
		const data = this.getCachedUsage();
		if (!data) {
			return {
				canProceed: true,
				maxModeEnabled: false,
				maxModeEligible: false,
				remaining: 0,
				limit: 0,
			};
		}

		const item = data.usage.find((u) => u.category === category);
		if (!item) {
			return {
				canProceed: true,
				maxModeEnabled: data.maxModeEnabled,
				maxModeEligible: data.maxModeEligible,
				remaining: 0,
				limit: 0,
			};
		}

		const percentage = (item.remaining / item.limit) * 100;
		if (percentage <= 10 && percentage > 0) {
			if (!this._lowQuotaWarningShown.has(category)) {
				this._lowQuotaWarningShown.add(category);
				vscode.window.showWarningMessage(
					`Deni AI: ${category} quota is low (${item.remaining}/${item.limit} remaining)`
				);
			}
		}

		return {
			canProceed: item.remaining > 0 || data.maxModeEnabled,
			maxModeEnabled: data.maxModeEnabled,
			maxModeEligible: data.maxModeEligible,
			remaining: item.remaining,
			limit: item.limit,
		};
	}

	resetWarnings(): void {
		this._lowQuotaWarningShown.clear();
	}

	getBillingUrl(): string {
		return getBillingUrl();
	}

	async loginWithDeviceAuth(): Promise<boolean> {
		const baseUrl = getDeniAiBaseUrl();

		let initiateResponse: DeviceAuthInitiateResponse;
		try {
			const res = await fetch(`${baseUrl}/api/device-auth`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'initiate' }),
			});
			if (!res.ok) {
				const responseText = await res.text();
				log(
					'[Flixa] loginWithDeviceAuth initiate failed',
					JSON.stringify({
						status: res.status,
						statusText: res.statusText,
						baseUrl,
						responseText,
					})
				);
				throw new Error(`HTTP ${res.status}`);
			}
			initiateResponse = (await res.json()) as DeviceAuthInitiateResponse;
		} catch (error) {
			log('[Flixa] loginWithDeviceAuth initiate error', error);
			vscode.window.showErrorMessage(
				'Deni AI: Failed to initiate login. Please try again.'
			);
			return false;
		}

		const { userCode, deviceCode } = initiateResponse;
		const authUrl = `${baseUrl}/flixa/authorize?code=${userCode}`;

		vscode.env.openExternal(vscode.Uri.parse(authUrl));

		return new Promise((resolve) => {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Deni AI: Waiting for approval... Code: ${userCode}`,
					cancellable: true,
				},
				async (_progress, token) => {
					const startTime = Date.now();
					let cancelled = false;

					token.onCancellationRequested(() => {
						cancelled = true;
					});

					while (!cancelled) {
						const elapsed = Date.now() - startTime;
						if (elapsed > DEVICE_AUTH_TIMEOUT_MS) {
							vscode.window.showErrorMessage(
								'Deni AI: Login timed out. Please try again.'
							);
							resolve(false);
							return;
						}

						await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

						if (cancelled) {
							resolve(false);
							return;
						}

						try {
							const res = await fetch(`${baseUrl}/api/device-auth`, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ action: 'poll', deviceCode }),
							});

							if (res.status === 410) {
								log(
									'[Flixa] loginWithDeviceAuth poll expired',
									JSON.stringify({ deviceCode })
								);
								vscode.window.showErrorMessage(
									'Deni AI: Login expired. Please try again.'
								);
								resolve(false);
								return;
							}

							if (!res.ok) {
								const responseText = await res.text();
								log(
									'[Flixa] loginWithDeviceAuth poll failed',
									JSON.stringify({
										status: res.status,
										statusText: res.statusText,
										baseUrl,
										deviceCode,
										responseText,
									})
								);
								vscode.window.showErrorMessage(
									'Deni AI: Login failed. Please try again.'
								);
								resolve(false);
								return;
							}

							const pollResponse =
								(await res.json()) as DeviceAuthPollResponse;
							log(
								'[Flixa] loginWithDeviceAuth poll response',
								JSON.stringify({
									deviceCode,
									approved: pollResponse.approved,
									hasApiKey: !!pollResponse.apiKey,
								})
							);

							if (pollResponse.approved && pollResponse.apiKey) {
								await this.setApiKey(pollResponse.apiKey);
								vscode.window.showInformationMessage(
									'Deni AI: Logged in successfully!'
								);
								resolve(true);
								return;
							}
						} catch (error) {
							log('[Flixa] loginWithDeviceAuth poll error', error);
						}
					}

					resolve(false);
				}
			);
		});
	}
}
