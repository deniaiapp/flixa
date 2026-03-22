import * as vscode from 'vscode';
import type { UsageService } from './service';
import type { Tier, UsageCategory, UsageResponse } from './types';

function formatNumber(n: number): string {
	return n.toLocaleString();
}

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
		return `${formatNumber(limit)} requests`;
	}

	return PAID_USAGE_LIMIT_LABELS[tier][category];
}

function formatUsageRemainingLabel(tier: Tier, remaining: number): string {
	if (tier === 'free') {
		return `${formatNumber(remaining)} requests remaining`;
	}

	return `${formatNumber(remaining)}m remaining`;
}

export class UsageStatusBarItem {
	private _statusBarItem: vscode.StatusBarItem;
	private _usageService: UsageService;
	private _isLoggedIn: boolean = false;

	constructor(usageService: UsageService) {
		this._usageService = usageService;
		this._statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100
		);
		this._statusBarItem.command = 'flixa.showUsageDetail';
		this._statusBarItem.show();

		this._usageService.onUsageChanged((data) => {
			this.update(data);
		});

		this._usageService.isLoggedIn().then((loggedIn) => {
			this._isLoggedIn = loggedIn;
			this.update(this._usageService.getCachedUsage());
		});
	}

	async refresh(): Promise<void> {
		this._isLoggedIn = await this._usageService.isLoggedIn();
		this.update(this._usageService.getCachedUsage());
	}

	update(data: UsageResponse | null): void {
		this._usageService.isLoggedIn().then((loggedIn) => {
			this._isLoggedIn = loggedIn;
			this._updateInternal(data);
		});
	}

	private _updateInternal(data: UsageResponse | null): void {
		if (!this._isLoggedIn) {
			this._statusBarItem.text = '$(account) Deni AI: Not connected';
			this._statusBarItem.tooltip = 'Click to log in';
			this._statusBarItem.backgroundColor = undefined;
			this._statusBarItem.color = undefined;
			return;
		}

		if (!data) {
			this._statusBarItem.text = '$(sync~spin) Deni AI: Loading...';
			this._statusBarItem.tooltip = 'Fetching usage data...';
			this._statusBarItem.backgroundColor = undefined;
			this._statusBarItem.color = undefined;
			return;
		}

		const tierLabel = data.isTeam
			? 'Pro (Team)'
			: data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
		const basic = data.usage.find((u) => u.category === 'basic');
		const premium = data.usage.find((u) => u.category === 'premium');

		let basicColor: string | undefined;
		let premiumColor: string | undefined;

		if (basic) {
			const basicPct = (basic.remaining / basic.limit) * 100;
			if (basicPct <= 0) {
				basicColor = 'red';
			} else if (basicPct <= 10) {
				basicColor = 'yellow';
			}
		}

		if (premium) {
			const premiumPct = (premium.remaining / premium.limit) * 100;
			if (premiumPct <= 0) {
				premiumColor = 'red';
			} else if (premiumPct <= 10) {
				premiumColor = 'yellow';
			}
		}

		this._statusBarItem.text = `Deni AI: ${tierLabel}`;

		const worstColor =
			basicColor === 'red' || premiumColor === 'red'
				? 'red'
				: basicColor === 'yellow' || premiumColor === 'yellow'
					? 'yellow'
					: undefined;

		if (worstColor === 'red') {
			this._statusBarItem.backgroundColor = new vscode.ThemeColor(
				'statusBarItem.errorBackground'
			);
			this._statusBarItem.color = undefined;
		} else if (worstColor === 'yellow') {
			this._statusBarItem.backgroundColor = new vscode.ThemeColor(
				'statusBarItem.warningBackground'
			);
			this._statusBarItem.color = undefined;
		} else {
			this._statusBarItem.backgroundColor = undefined;
			this._statusBarItem.color = undefined;
		}

		const tooltipLines = [
			`Tier: ${tierLabel}`,
			`Status: ${data.status || 'N/A'}`,
		];
		if (basic) {
			tooltipLines.push(
				`Basic: ${formatNumber(basic.used)}/${formatUsageLimitLabel(data.tier, basic.category, basic.limit)} (${formatUsageRemainingLabel(data.tier, basic.remaining)})`
			);
		}
		if (premium) {
			tooltipLines.push(
				`Premium: ${formatNumber(premium.used)}/${formatUsageLimitLabel(data.tier, premium.category, premium.limit)} (${formatUsageRemainingLabel(data.tier, premium.remaining)})`
			);
		}
		if (data.periodEnd) {
			tooltipLines.push(
				`Resets: ${new Date(data.periodEnd).toLocaleDateString()}`
			);
		}
		this._statusBarItem.tooltip = tooltipLines.join('\n');
	}

	dispose(): void {
		this._statusBarItem.dispose();
	}
}
