import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { getAwsSdkBaseClientConfig } from './awsSdkBaseClientConfig.js';

/** @type {CognitoIdentityProviderClient | null} */
let client = null;

export function getCognitoIdpClient() {
  if (!client) {
    client = new CognitoIdentityProviderClient(getAwsSdkBaseClientConfig('Cognito auth'));
  }
  return client;
}

export function getCognitoUserPoolId() {
  const poolId = process.env.COGNITO_USER_POOL_ID?.trim();
  if (!poolId) {
    throw new Error('COGNITO_USER_POOL_ID is not configured');
  }
  return poolId;
}

export function getCognitoClientId() {
  const clientId = process.env.COGNITO_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error('COGNITO_CLIENT_ID is not configured');
  }
  return clientId;
}
