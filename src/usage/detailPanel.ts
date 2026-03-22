import * as vscode from 'vscode';
import type { UsageService } from './service';
import type { Tier, UsageCategory } from './types';
import { getBillingUrl } from './service';

const PAID_USAGE_LIMIT_LABELS: Record<
	Exclude<Tier, 'free'>,
	Record<UsageCategory, string>
> = {
	plus: {
		basic: '20m',
		premium: '5m',
	},
	pro: {
		basic: '50m',
		premium: '15m',
	},
	max: {
		basic: '120m',
		premium: '40m',
	},
};

function formatUsageLimitLabel(
	tier: Tier,
	category: UsageCategory,
	limit: number
): string {
	if (tier === 'free') {
		return `${limit.toLocaleString()} requests`;
	}

	return PAID_USAGE_LIMIT_LABELS[tier][category];
}

function formatUsageRemainingLabel(tier: Tier, remaining: number): string {
	if (tier === 'free') {
		return `${remaining.toLocaleString()} requests remaining`;
	}

	return `${remaining.toLocaleString()}m remaining`;
}

export async function showUsageDetailPanel(
	usageService: UsageService
): Promise<void> {
	const isLoggedIn = await usageService.isLoggedIn();
	if (!isLoggedIn) {
		const action = await vscode.window.showQuickPick(
			[
				{ label: '$(sign-in) Login with Deni AI', value: 'deviceAuth' },
				{ label: '$(key) Enter API Key manually', value: 'manualKey' },
			],
			{
				placeHolder: 'You are not connected to Deni AI',
			}
		);

		if (action?.value === 'deviceAuth') {
			await usageService.loginWithDeviceAuth();
		} else if (action?.value === 'manualKey') {
			const key = await vscode.window.showInputBox({
				prompt: 'Enter your Deni AI API key (starts with deni_)',
				password: true,
				validateInput: (value) => {
					if (!value.startsWith('deni_')) {
						return 'API key must start with deni_';
					}
					return null;
				},
			});
			if (key) {
				await usageService.setApiKey(key);
			}
		}
		return;
	}

	const data = usageService.getCachedUsage();
	if (!data) {
		await usageService.fetchUsage(true);
		const freshData = usageService.getCachedUsage();
		if (!freshData) {
			vscode.window.showErrorMessage('Failed to fetch usage data');
			return;
		}
		await showUsageQuickPick(usageService, freshData);
		return;
	}

	await showUsageQuickPick(usageService, data);
}

async function showUsageQuickPick(
	usageService: UsageService,
	data: import('./types').UsageResponse
): Promise<void> {
	const tierLabel = data.isTeam
		? 'Pro (Team)'
		: data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
	const items: vscode.QuickPickItem[] = [];

	items.push({
		label: `$(account) Tier: ${tierLabel}`,
		description: data.status ? `(${data.status})` : '',
		kind: vscode.QuickPickItemKind.Default,
	});

	items.push({
		label: '',
		kind: vscode.QuickPickItemKind.Separator,
	});

	for (const usage of data.usage) {
		const pct = Math.round((usage.used / usage.limit) * 100);
		const bar = createProgressBar(pct);
		const categoryLabel =
			usage.category.charAt(0).toUpperCase() + usage.category.slice(1);
		items.push({
			label: `$(graph) ${categoryLabel}: ${usage.used.toLocaleString()}/${formatUsageLimitLabel(data.tier, usage.category, usage.limit)}`,
			description: `${bar} ${formatUsageRemainingLabel(data.tier, usage.remaining)}`,
		});
	}

	if (data.periodEnd) {
		const resetDate = new Date(data.periodEnd);
		items.push({
			label: `$(calendar) Resets: ${resetDate.toLocaleDateString()}`,
			description: '',
		});
	}

	items.push({
		label: '',
		kind: vscode.QuickPickItemKind.Separator,
	});

	const maxModeStatus = data.maxModeEnabled
		? '$(check) Enabled'
		: data.maxModeEligible
			? '$(info) Eligible (not enabled)'
			: '$(x) Not available';
	items.push({
		label: `$(zap) Max Mode: ${maxModeStatus}`,
		description: '',
	});

	items.push({
		label: '',
		kind: vscode.QuickPickItemKind.Separator,
	});

	items.push({
		label: '$(refresh) Refresh',
		description: 'Fetch latest usage data',
		alwaysShow: true,
	});

	items.push({
		label: '$(link-external) Upgrade Plan',
		description: 'Open billing page in browser',
		alwaysShow: true,
	});

	items.push({
		label: '$(sign-out) Logout',
		description: 'Disconnect from Deni AI',
		alwaysShow: true,
	});

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Deni AI Usage',
		matchOnDescription: true,
	});

	if (selected?.label === '$(refresh) Refresh') {
		await usageService.fetchUsage(true);
		const freshData = usageService.getCachedUsage();
		if (freshData) {
			await showUsageQuickPick(usageService, freshData);
		}
	} else if (selected?.label === '$(link-external) Upgrade Plan') {
		vscode.env.openExternal(vscode.Uri.parse(getBillingUrl()));
	} else if (selected?.label === '$(sign-out) Logout') {
		await usageService.logout();
		vscode.window.showInformationMessage('Deni AI: Logged out');
	}
}

function createProgressBar(percentage: number): string {
	const filled = Math.round(percentage / 10);
	const empty = 10 - filled;
	return '█'.repeat(filled) + '░'.repeat(empty);
}
