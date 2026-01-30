/**
 * Kalshi WebSocket Authentication
 * Signs requests using RSA-PSS (SHA-256)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadKalshiCredentials() {
    const keyId = process.env.KALSHI_API_KEY || '6be3c7c4-fb0e-4b94-8409-d37d7f719f01';
    
    let privateKey;
    const keyPath = path.join(__dirname, '..', '.kalshi-key.pem');
    
    if (process.env.KALSHI_PRIVATE_KEY) {
        privateKey = process.env.KALSHI_PRIVATE_KEY;
    } else if (fs.existsSync(keyPath)) {
        privateKey = fs.readFileSync(keyPath, 'utf8');
    } else {
        throw new Error('Kalshi private key not found. Set KALSHI_PRIVATE_KEY env var or place .kalshi-key.pem in project root.');
    }

    return { keyId, privateKey };
}

/**
 * Generate authentication headers for Kalshi WebSocket connection
 * Follows: timestamp + method + path → RSA-PSS signature
 */
export function generateKalshiHeaders(keyId, privateKeyPem, method = 'GET', wsPath = '/trade-api/ws/v2') {
    const timestamp = Date.now().toString();
    const message = timestamp + method + wsPath;

    const privateKey = crypto.createPrivateKey({
        key: privateKeyPem,
        format: 'pem',
    });

    const signature = crypto.sign('sha256', Buffer.from(message), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });

    return {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
}

/**
 * Generate REST API headers (same pattern, different path)
 */
export function generateKalshiRestHeaders(keyId, privateKeyPem, method, apiPath) {
    const timestamp = Date.now().toString();
    const cleanPath = apiPath.split('?')[0];
    const message = timestamp + method + cleanPath;

    const privateKey = crypto.createPrivateKey({
        key: privateKeyPem,
        format: 'pem',
    });

    const signature = crypto.sign('sha256', Buffer.from(message), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });

    return {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
    };
}

export default { loadKalshiCredentials, generateKalshiHeaders, generateKalshiRestHeaders };
