import * as vscode from 'vscode';
import {
  describeDeviceAuthKeyProblem,
  fetchDeniUsage,
  FlixaApiError,
  getBillingUrl,
  initiateDeviceAuth,
  resolveDeniAiBaseUrl,
  waitForDeviceAuth,
  type DeviceAuthSession,
} from '@deniai/flixa-api-client';
import type {
  CachedUsage,
  QuotaExceededErrorMeta,
  Tier,
  UsageCategory,
  UsageResponse,
} from './types';
import {
  getClientSignalUserMessage,
  getFlixaClientHeaders,
  logMissingClientSignal,
} from '../api/flixaClientHeaders';
import { log } from '../logger';
import { canUseTier, getModelTierRequirement, primaryUsage } from './types';

export { getBillingUrl } from '@deniai/flixa-api-client';

const CACHE_DURATION_MS = 5 * 60 * 1000;
const API_KEY_SECRET_KEY = 'deniApiKey';

export async function showQuotaExceededDialog(
  error: QuotaExceededErrorMeta,
  onAfterAction?: () => Promise<void>,
): Promise<void> {
  // Usage is one pool shared with Deni AI chat and Deni Run, not split by model class.
  const title = 'Usage limit reached';
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

  const selected = await vscode.window.showErrorMessage(message, { modal: true }, ...actions);

  if (selected === 'Verify card' && error.verifyUrl) {
    vscode.env.openExternal(vscode.Uri.parse(error.verifyUrl));
  } else if (selected === 'Upgrade' && error.upgradeUrl) {
    vscode.env.openExternal(vscode.Uri.parse(error.upgradeUrl));
  }

  if (onAfterAction) {
    await onAfterAction();
  }
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
    if (!apiKey) {
      this._onUsageChanged.fire(null);
      return null;
    }

    if (!force && this._cache) {
      const age = Date.now() - this._cache.fetchedAt;
      if (age < CACHE_DURATION_MS) {
        return this._cache.data;
      }
    }

    try {
      const data = await fetchDeniUsage({ apiKey, headers: getFlixaClientHeaders() });
      this._cache = {
        data,
        fetchedAt: Date.now(),
      };
      this._onUsageChanged.fire(data);
      return data;
    } catch (error) {
      if (error instanceof FlixaApiError && (error.status === 401 || error.status === 403)) {
        return this._handleUsageAuthError(error);
      }
      console.log('[Flixa] fetchUsage - error:', error);
      if (this._cache) {
        return this._cache.data;
      }
      return null;
    }
  }

  private async _handleUsageAuthError(error: FlixaApiError): Promise<null> {
    const errorCode = error.code;
    if (errorCode === 'missing_client_signal') {
      logMissingClientSignal('/v1/deni/usage');
    }

    const clientMessage =
      (errorCode && getClientSignalUserMessage(errorCode)) ||
      (error.status === 401 ? 'API key is invalid or expired. Please log in again.' : null);

    if (error.status === 401) {
      await this.logout();
    }

    if (clientMessage) {
      vscode.window.showErrorMessage(`Flixa: ${clientMessage}`);
      return null;
    }

    vscode.window.showErrorMessage('Flixa: Access denied. Please contact support.');
    return null;
  }

  incrementUsage(category: UsageCategory): void {
    if (!this._cache) {
      return;
    }
    const usageItem = this._cache.data.usage.find((u) => u.category === category);
    if (usageItem && usageItem.remaining !== null && usageItem.remaining > 0) {
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
    limit: number | null;
    remaining: number | null;
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

    const item = primaryUsage(data);
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
          `Deni AI: monthly usage is low (${Math.round(percentage)}% left)`,
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
    let session: DeviceAuthSession;
    try {
      session = await initiateDeviceAuth();
    } catch (error) {
      log(
        '[Flixa] loginWithDeviceAuth initiate failed',
        error instanceof FlixaApiError
          ? JSON.stringify({
              status: error.status,
              statusText: error.statusText,
              responseText: error.rawText,
            })
          : error,
      );
      vscode.window.showErrorMessage('Deni AI: Failed to initiate login. Please try again.');
      return false;
    }

    vscode.env.openExternal(vscode.Uri.parse(session.verificationUrl));

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deni AI: Waiting for approval... Code: ${session.userCode}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const outcome = await waitForDeviceAuth(session, {
          signal: controller.signal,
          onPollError: (error) => log('[Flixa] loginWithDeviceAuth poll error', error),
          onPollResult: (result) =>
            log(
              '[Flixa] loginWithDeviceAuth poll response',
              JSON.stringify({ status: result.status }),
            ),
        });

        switch (outcome.status) {
          case 'approved':
            await this.setApiKey(outcome.apiKey);
            vscode.window.showInformationMessage('Deni AI: Logged in successfully!');
            return true;
          case 'api_key_unavailable':
          case 'api_key_limit_reached': {
            const openAction = 'Open Deni AI';
            const selected = await vscode.window.showErrorMessage(
              'Deni AI: Login could not create an API key.',
              { modal: true, detail: describeDeviceAuthKeyProblem(outcome) },
              openAction,
            );
            if (selected === openAction) {
              vscode.env.openExternal(vscode.Uri.parse(resolveDeniAiBaseUrl()));
            }
            return false;
          }
          case 'expired':
            vscode.window.showErrorMessage('Deni AI: Login expired. Please try again.');
            return false;
          case 'timed_out':
            vscode.window.showErrorMessage('Deni AI: Login timed out. Please try again.');
            return false;
          case 'cancelled':
            return false;
          case 'invalid_code':
          case 'error':
            log('[Flixa] loginWithDeviceAuth failed', JSON.stringify({ status: outcome.status }));
            vscode.window.showErrorMessage('Deni AI: Login failed. Please try again.');
            return false;
        }
      },
    );
  }
}
