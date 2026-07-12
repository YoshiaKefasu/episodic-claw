import { runGatewayStartSmoke } from "./test_phase4_5_gateway_runtime.ts";
import {
  runAnchorInjectionSmoke,
  runDegradedFallbackGuardSmoke,
  runRetrieverRuntimeRegression,
  runRetrieverSourceSmoke,
  runPolyglotQueryMorphologicalTests
} from "./test_phase4_5_retriever_anchor.ts";
import {
  runNarrativeWorkerEmptyRawTextGuardRegression,
  runLanguageGuardReaskHandoffRegression,
  runNarrativeWorkerFalseSystemMode
} from "./test_phase4_5_narrative_worker.ts";
import { runJapaneseQueryParserFallbackTests } from "./test_phase4_5_japanese_query_parser.ts";
import {
  runCompactionModelSmoke,
  runPhase7EscalationAndRepairSmoke,
  runReleaseGateA,
  runReleaseGateB,
  runReleaseGateC,
  runSurpriseMetadataRegression,
  runSurpriseMetadataRoundTrip,
  runIdleFlushRuntimeRegression,
  runIdlePollLogStormRegression,
  runCacheQueueIntegrationSmoke,
  runCacheQueueSmoke
} from "./test_phase4_5_cache_compaction_segmenter.ts";
import { runNear64kPrefixFlushTests } from "./test_phase4_5_near64k_prefix_flush.ts";

async function main() {
  console.log("=== Phase 4/5 Smoke & Regression Tests (Modular) ===");

  // E2: Gateway Runtime tests
  await runGatewayStartSmoke();

  // E3: Retriever / Anchor tests
  await runAnchorInjectionSmoke();
  await runDegradedFallbackGuardSmoke();
  await runRetrieverRuntimeRegression();
  await runRetrieverSourceSmoke();
  await runPolyglotQueryMorphologicalTests();
  await runJapaneseQueryParserFallbackTests();

  // E4: Narrative Worker tests
  await runNarrativeWorkerEmptyRawTextGuardRegression();
  await runLanguageGuardReaskHandoffRegression();
  // [v0.5.1] narrativeSystemPrompt=false mode tests
  await runNarrativeWorkerFalseSystemMode();

  // E5: Cache / Compaction / Segmenter tests
  await runCompactionModelSmoke();
  await runPhase7EscalationAndRepairSmoke();
  await runReleaseGateA();
  await runReleaseGateB();
  await runReleaseGateC();
  await runSurpriseMetadataRegression();
  await runSurpriseMetadataRoundTrip();
  await runIdleFlushRuntimeRegression();
  await runIdlePollLogStormRegression();
  await runCacheQueueIntegrationSmoke();
  await runCacheQueueSmoke();

  // [v0.5.0 Phase 1.5] Near-64K prefix flush tests
  await runNear64kPrefixFlushTests();

  console.log("=== ALL PHASE 4/5 TESTS PASSED ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
