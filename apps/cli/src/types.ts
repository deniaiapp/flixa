export interface DeviceAuthInitiateResponse {
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  verificationUri?: string;
}

export interface DeviceAuthPollResponse {
  approved: boolean;
  apiKey?: string;
}

export interface Credentials {
  apiKey: string;
}
