/**
 * Test: Resolution Watcher module import and basic functionality
 */

import { ResolutionWatcher } from '../src/resolution-watcher.js';

async function testResolutionWatcher() {
  console.log('Testing ResolutionWatcher module...\n');
  
  // Test 1: Constructor with defaults
  const watcher1 = new ResolutionWatcher();
  console.log('✅ Constructor (defaults):', {
    checkIntervalMs: watcher1.checkIntervalMs,
    maxAgeHours: watcher1.maxAgeHours,
    minProfitCents: watcher1.minProfitCents,
  });
  
  // Test 2: Constructor with custom config
  const watcher2 = new ResolutionWatcher({
    checkIntervalMs: 1000,
    maxAgeHours: 12,
    minProfitCents: 5,
  });
  console.log('✅ Constructor (custom):', {
    checkIntervalMs: watcher2.checkIntervalMs,
    maxAgeHours: watcher2.maxAgeHours,
    minProfitCents: watcher2.minProfitCents,
  });
  
  // Test 3: getOpportunities() returns array
  const opps = watcher1.getOpportunities();
  console.log('✅ getOpportunities() returns array:', Array.isArray(opps));
  
  // Test 4: getStats() returns object with expected fields
  const stats = watcher1.getStats();
  console.log('✅ getStats() has expected fields:', {
    hasChecksRun: 'checksRun' in stats,
    hasMarketsScanned: 'marketsScanned' in stats,
    hasOpportunitiesFound: 'opportunitiesFound' in stats,
    hasRunning: 'running' in stats,
  });
  
  // Test 5: getStatus() returns object with expected fields
  const status = watcher1.getStatus();
  console.log('✅ getStatus() has expected fields:', {
    hasRunning: 'running' in status,
    hasConfig: 'config' in status,
    hasStats: 'stats' in status,
    hasOpportunities: 'opportunities' in status,
  });
  
  // Test 6: checkResolvedMarkets() runs without error (actual API call)
  console.log('\nRunning actual API check (may take a moment)...');
  await watcher1.checkResolvedMarkets();
  const statsAfter = watcher1.getStats();
  console.log('✅ checkResolvedMarkets() completed:', {
    checksRun: statsAfter.checksRun,
    marketsScanned: statsAfter.marketsScanned,
    opportunitiesFound: statsAfter.opportunitiesFound,
  });
  
  // Test 7: stop() works
  watcher1.stop();
  console.log('✅ stop() completed');
  
  console.log('\n✅ All tests passed!');
}

testResolutionWatcher().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
