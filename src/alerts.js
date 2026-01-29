/**
 * Alert system for arbitrage opportunities
 * Sends notifications via iMessage when profitable opportunities are found
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// Alert configuration
const ALERT_CONFIG = {
    // Minimum profit in cents to trigger an alert
    minProfitForAlert: 2.0,
    // Cooldown between alerts for the same outcome (ms)
    alertCooldownMs: 15 * 60 * 1000, // 15 minutes
    // Phone number to send alerts to (Eduardo)
    phoneNumber: '+15404497203',
    // Log file for tracking alerts
    alertLogPath: './alerts.log',
};

// Track last alert time per outcome
const lastAlertTime = new Map();

/**
 * Check if we should send an alert for this opportunity
 */
export function shouldAlert(opportunity) {
    if (opportunity.profit < ALERT_CONFIG.minProfitForAlert) {
        return false;
    }

    const lastTime = lastAlertTime.get(opportunity.outcome);
    if (lastTime && Date.now() - lastTime < ALERT_CONFIG.alertCooldownMs) {
        return false;
    }

    return true;
}

/**
 * Send an iMessage alert
 */
export async function sendAlert(opportunity) {
    if (!shouldAlert(opportunity)) return false;

    const message = formatAlertMessage(opportunity);
    
    try {
        // Use imsg CLI to send the message
        const escapedMessage = message.replace(/"/g, '\\"');
        await execAsync(`imsg send --to "${ALERT_CONFIG.phoneNumber}" --text "${escapedMessage}"`);
        
        // Update last alert time
        lastAlertTime.set(opportunity.outcome, Date.now());
        
        // Log the alert
        logAlert(opportunity);
        
        console.log(`[ALERT SENT] ${opportunity.outcome}: ${opportunity.profit.toFixed(2)}¢`);
        return true;
    } catch (error) {
        console.error(`[ALERT FAILED] ${error.message}`);
        return false;
    }
}

/**
 * Format the alert message
 */
function formatAlertMessage(opportunity) {
    const now = new Date().toLocaleTimeString();
    return `🎯 ARB ALERT [${now}]

${opportunity.outcome}
Profit: ${opportunity.profit.toFixed(2)}¢ per contract
${opportunity.description}

Volume: $${(opportunity.totalVolume || 0).toLocaleString()}
ROI: ~${((opportunity.profit / (100 - opportunity.profit)) * 100).toFixed(1)}%`;
}

/**
 * Log alert to file for tracking
 */
function logAlert(opportunity) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        outcome: opportunity.outcome,
        profit: opportunity.profit,
        description: opportunity.description,
        volume: opportunity.totalVolume,
    };

    const logLine = JSON.stringify(logEntry) + '\n';
    
    try {
        fs.appendFileSync(ALERT_CONFIG.alertLogPath, logLine);
    } catch (error) {
        // Ignore logging errors
    }
}

/**
 * Check multiple opportunities and send alerts for qualifying ones
 */
export async function checkAndAlert(opportunities) {
    const alertsSent = [];
    
    for (const opp of opportunities) {
        if (shouldAlert(opp)) {
            const sent = await sendAlert(opp);
            if (sent) alertsSent.push(opp.outcome);
        }
    }
    
    return alertsSent;
}

export default {
    sendAlert,
    shouldAlert,
    checkAndAlert,
    ALERT_CONFIG,
};
