import * as vscode from 'vscode';
import type { UsageService } from './service';
import { isMaxTeamPlan, primaryUsage, remainingPercent, type UsageResponse } from './types';

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

		const tierLabel = isMaxTeamPlan(data.planId)
			? 'Max (Team)'
			: data.isTeam
				? 'Pro (Team)'
				: data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
		const usage = primaryUsage(data);
		const leftPct = usage ? remainingPercent(usage) : null;

		this._statusBarItem.text = `Deni AI: ${tierLabel}`;

		const worstColor =
			leftPct === null ? undefined : leftPct <= 0 ? 'red' : leftPct <= 10 ? 'yellow' : undefined;

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
		if (leftPct !== null) {
			// One pool shared with Deni AI chat and Deni Run; shown as a percentage only.
			tooltipLines.push(`Monthly usage: ${Math.round(leftPct)}% left`);
		}
		if (data.tier === 'free' && data.hasVerifiedPaymentMethod) {
			tooltipLines.push('Card verified');
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
