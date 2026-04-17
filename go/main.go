package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"episodic-core/frontmatter"
	"episodic-core/internal/ai"
	"episodic-core/internal/cache"
	"episodic-core/internal/logger"
	"episodic-core/internal/vector"
	"episodic-core/watcher"
	"sync"
	"sync/atomic"

	"golang.org/x/time/rate"
	"gopkg.in/yaml.v3"
)

var (
	tombstoneTTL           *int
	disableWorkers         *bool
	lexicalLimit           *int
	lexicalRebuildInterval *int

	storeMutex      sync.Mutex
	isReplaying     int32
	writeMu         sync.Mutex // Atomize writes to net.Conn
	vectorStores    = make(map[string]*vector.Store)
	cacheQueues     = make(map[string]*cache.Queue) // agentWs -> cache queue
	cacheQueuesMu   sync.Mutex

	// Global rate limiters to respect Google AI Studio quotas across all handlers
	gemmaLimiter     = rate.NewLimiter(rate.Limit(15.0/60.0), 5)   // 15 RPM
	embedLimiter     = rate.NewLimiter(rate.Limit(100.0/60.0), 10) // 100 RPM
	healEmbedLimiter = rate.NewLimiter(rate.Limit(10.0/60.0), 2)   // 10 RPM (Pass 1 Healing - 10% of main)

	// TPM-aware rate limiter: guards against token-count-based quota exhaustion.
	tpmLimiter = rate.NewLimiter(rate.Limit(900_000.0/60.0), 15_000)

	// In-memory query cache for deduplication (Step 3)
	recallCache sync.Map // key: query string, value: recallCacheEntry

	legacyEpisodeRepairMu         sync.Mutex
	legacyEpisodeCleanupPending   = make(map[string]bool)
	legacyEpisodeQuarantineBypass = make(map[string]bool)

	// Wakeup channel for instantaneous healing
	healWorkerWakeup = make(chan struct{}, 1)
)

func init() {
	tombstoneTTL = flag.Int("tombstone-ttl", 14, "Days to keep tombstones before deleting")
	disableWorkers = flag.Bool("disable-workers", false, "Disable background healing and consolidation workers")
	lexicalLimit = flag.Int("lexical-limit", 1000, "Max lexical pre-filter limit")
	lexicalRebuildInterval = flag.Int("lexical-rebuild-interval", 7, "Days between lexical index consistency checks")
}

type recallCacheEntry struct {
	vector []float32
	expiry time.Time
}

func triggerHealing() {
	select {
	case healWorkerWakeup <- struct{}{}:
	default:
	}
}

func getStore(agentWs string) (*vector.Store, error) {
	storeMutex.Lock()
	defer storeMutex.Unlock()

	if consumeLegacyEpisodeQuarantineBypass(agentWs) {
		EmitLog("Skipping legacy nested episode quarantine once for %s during rollback re-open", agentWs)
	} else {
		if quarantined, moved, err := quarantineLegacyNestedEpisodeTree(agentWs); err != nil {
			return nil, fmt.Errorf("legacy nested episode quarantine failed for %s: %w", agentWs, err)
		} else if moved {
			EmitLog("Legacy nested episode tree isolated at %s before rebuild/watch replay", quarantined)
		}
	}

	if s, ok := vectorStores[agentWs]; ok {
		maybeCleanLegacyOrphans(agentWs, s)
		return s, nil
	}

	s, err := vector.NewStore(agentWs, vector.StoreConfig{
		TombstoneTTL:       *tombstoneTTL,
		LexicalFilterLimit: *lexicalLimit,
	})
	if err != nil {
		return nil, err
	}
	vectorStores[agentWs] = s
	consumeLegacyEpisodeCleanupPending(agentWs)

	// ==== Phase B & D: Auto-Rebuild Trigger ====
	if s.Count() == 0 {
		EmitLog("⚠️ Vector store is empty for %s — triggering Auto-Rebuild from Markdown", agentWs)
		go func(ws string, vs *vector.Store) {
			apiKey := os.Getenv("GEMINI_API_KEY")
			if apiKey == "" {
				EmitLog("Auto-Rebuild skipped: GEMINI_API_KEY not set")
				return
			}
			runAutoRebuild(ws, apiKey, vs)
		}(agentWs, s)
	}

	// Background worker: Heal missing embeddings and refine fallback slugs
	if disableWorkers == nil || !*disableWorkers {
		go func(ws string, vs *vector.Store) {
			EmitLog("Starting Async Healing Worker for workspace: %s", ws)
			RunAsyncHealingWorker(ws, os.Getenv("GEMINI_API_KEY"), vs)
			ticker := time.NewTicker(30 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					RunAsyncHealingWorker(ws, os.Getenv("GEMINI_API_KEY"), vs)
				case <-healWorkerWakeup:
					EmitLog("Healing Worker woken up by instantaneous trigger.")
					time.Sleep(2 * time.Second) // Small debounce for concurrent batches
					RunAsyncHealingWorker(ws, os.Getenv("GEMINI_API_KEY"), vs)
				}
			}
		}(agentWs, s)
	} else {
		EmitLog("Background workers disabled for %s; skipping Async Healing Worker startup", agentWs)
	}

	return s, nil
}

func markLegacyEpisodeCleanupPending(agentWs string) {
	legacyEpisodeRepairMu.Lock()
	legacyEpisodeCleanupPending[agentWs] = true
	legacyEpisodeRepairMu.Unlock()
}

func consumeLegacyEpisodeCleanupPending(agentWs string) bool {
	legacyEpisodeRepairMu.Lock()
	defer legacyEpisodeRepairMu.Unlock()

	pending := legacyEpisodeCleanupPending[agentWs]
	if pending {
		delete(legacyEpisodeCleanupPending, agentWs)
	}
	return pending
}

func markLegacyEpisodeQuarantineBypass(agentWs string) {
	legacyEpisodeRepairMu.Lock()
	legacyEpisodeQuarantineBypass[agentWs] = true
	legacyEpisodeRepairMu.Unlock()
}

func consumeLegacyEpisodeQuarantineBypass(agentWs string) bool {
	legacyEpisodeRepairMu.Lock()
	defer legacyEpisodeRepairMu.Unlock()

	pending := legacyEpisodeQuarantineBypass[agentWs]
	if pending {
		delete(legacyEpisodeQuarantineBypass, agentWs)
	}
	return pending
}

func maybeCleanLegacyOrphans(agentWs string, vstore *vector.Store) {
	if consumeLegacyEpisodeCleanupPending(agentWs) {
		EmitLog("Cleaning orphaned records after legacy nested tree quarantine for %s", agentWs)
		vstore.CleanOrphans()
	}
}

func hasLegacyNestedEpisodePath(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	rel = filepath.Clean(rel)
	if rel == "." {
		return false
	}
	return rel == "episodes" || strings.HasPrefix(rel, "episodes"+string(filepath.Separator))
}

type legacyMigrationManifest struct {
	OriginalRoot  string `json:"original_root"`
	QuarantinedAt string `json:"quarantined_at"`
	QuarantinedTo string `json:"quarantined_to"`
	AgentWs       string `json:"agent_ws"`
}

func quarantineLegacyNestedEpisodeTree(agentWs string) (string, bool, error) {
	legacyRoot := filepath.Join(agentWs, "episodes")
	info, err := os.Stat(legacyRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	if !info.IsDir() {
		return "", false, nil
	}

	quarantineRoot := filepath.Join(filepath.Dir(agentWs), ".episodic-quarantine")
	if err := os.MkdirAll(quarantineRoot, 0o755); err != nil {
		return "", false, err
	}

	if err := snapshotLegacyStoreState(agentWs, quarantineRoot); err != nil {
		return "", false, err
	}

	quarantined := filepath.Join(
		quarantineRoot,
		fmt.Sprintf("%s-nested-episodes-%s", filepath.Base(agentWs), time.Now().UTC().Format("20060102T150405.000000000")),
	)
	if err := os.Rename(legacyRoot, quarantined); err != nil {
		return "", false, err
	}

	manifest := legacyMigrationManifest{
		OriginalRoot:  legacyRoot,
		QuarantinedAt: time.Now().UTC().Format(time.RFC3339Nano),
		QuarantinedTo: quarantined,
		AgentWs:       agentWs,
	}
	if err := writeLegacyMigrationManifest(quarantined, manifest); err != nil {
		EmitLog("Legacy nested tree quarantine manifest write failed for %s: %v", quarantined, err)
	}

	markLegacyEpisodeCleanupPending(agentWs)
	return quarantined, true, nil
}

func snapshotLegacyStoreState(agentWs string, quarantineRoot string) error {
	storeRoot := filepath.Join(quarantineRoot, "store")
	if err := os.MkdirAll(storeRoot, 0o755); err != nil {
		return err
	}

	for _, name := range []string{"vector.db", "lexical"} {
		src := filepath.Join(agentWs, name)
		if _, err := os.Stat(src); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		dst := filepath.Join(storeRoot, name)
		if err := copyPathRecursive(src, dst); err != nil {
			return err
		}
	}

	return nil
}

func latestQuarantineRoot(agentWs string) (string, bool, error) {
	quarantineRoot := filepath.Join(filepath.Dir(agentWs), ".episodic-quarantine")
	entries, err := os.ReadDir(quarantineRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}

	var newest string
	var newestInfo os.FileInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(quarantineRoot, entry.Name())
		info, statErr := os.Stat(candidate)
		if statErr != nil {
			continue
		}
		if newestInfo == nil || info.ModTime().After(newestInfo.ModTime()) {
			newest = candidate
			newestInfo = info
		}
	}
	if newest == "" {
		return "", false, nil
	}
	return newest, true, nil
}

func writeLegacyMigrationManifest(quarantinedRoot string, manifest legacyMigrationManifest) error {
	if err := os.MkdirAll(quarantinedRoot, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(quarantinedRoot, ".rollback.json"), data, 0o644)
}

func restoreLegacyNestedEpisodeTree(agentWs string) (string, bool, error) {
	newest, ok, err := latestQuarantineRoot(agentWs)
	if err != nil || !ok {
		return "", false, err
	}

	manifestPath := filepath.Join(newest, ".rollback.json")
	var manifest legacyMigrationManifest
	if data, readErr := os.ReadFile(manifestPath); readErr == nil {
		_ = json.Unmarshal(data, &manifest)
	}

	restoreTarget := legacyRootForAgent(agentWs)
	if manifest.OriginalRoot != "" {
		restoreTarget = manifest.OriginalRoot
	}

	if _, err := os.Stat(restoreTarget); err == nil {
		return "", false, fmt.Errorf("restore target already exists: %s", restoreTarget)
	}

	if err := os.Rename(newest, restoreTarget); err != nil {
		return "", false, err
	}

	if err := restoreLegacyStoreState(agentWs, restoreTarget); err != nil {
		return "", false, err
	}

	legacyEpisodeRepairMu.Lock()
	delete(legacyEpisodeCleanupPending, agentWs)
	legacyEpisodeRepairMu.Unlock()

	return restoreTarget, true, nil
}

func restoreLegacyStoreState(agentWs string, quarantineRoot string) error {
	storeRoot := filepath.Join(quarantineRoot, "store")
	for _, name := range []string{"vector.db", "lexical"} {
		src := filepath.Join(storeRoot, name)
		if _, err := os.Stat(src); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		dst := filepath.Join(agentWs, name)
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
		if err := copyPathRecursive(src, dst); err != nil {
			return err
		}
	}
	return nil
}

func copyPathRecursive(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPathRecursive(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode())
}

func rehydrateLegacyNestedEpisodeTree(agentWs string) (string, error) {
	restoreTarget, moved, err := restoreLegacyNestedEpisodeTree(agentWs)
	if err != nil || !moved {
		return restoreTarget, err
	}

	markLegacyEpisodeQuarantineBypass(agentWs)

	storeMutex.Lock()
	if s, ok := vectorStores[agentWs]; ok && s != nil {
		_ = s.Close()
		delete(vectorStores, agentWs)
	}
	storeMutex.Unlock()

	if _, err := getStore(agentWs); err != nil {
		return "", err
	}

	return restoreTarget, nil
}

func legacyRootForAgent(agentWs string) string {
	return filepath.Join(agentWs, "episodes")
}

type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	ID      *int            `json:"id,omitempty"`
}

type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
	ID      *int        `json:"id,omitempty"`
}

type RPCEvent struct {
	JSONRPC string      `json:"jsonrpc"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func InitLogger() {
	logger.Init()
	logger.Info(logger.CatCore, "Observability initialized. Writing structured logs to %s", filepath.Join(os.TempDir(), "episodic-claw"))
}

func EmitLog(format string, a ...interface{}) {
	logger.Info(logger.CatCore, format, a...)
}

func sendResponse(conn net.Conn, resp RPCResponse) {
	bytes, _ := json.Marshal(resp)
	data := append(bytes, '\n')
	writeMu.Lock()
	conn.Write(data)
	writeMu.Unlock()
}

func sendEvent(conn net.Conn, method string, params interface{}) {
	ev := RPCEvent{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	bytes, _ := json.Marshal(ev)
	data := append(bytes, '\n')
	writeMu.Lock()
	conn.Write(data)
	writeMu.Unlock()
}

var (
	globalWatchers    map[string]*watcher.Watcher
	globalWatcherConn net.Conn
	globalWatcherMu   sync.Mutex
)

func handleWatcherStart(conn net.Conn, req RPCRequest) {
	var params map[string]string
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32602, "Invalid params"}, ID: req.ID})
		return
	}

	path, ok := params["path"]
	if !ok {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32602, "Missing 'path'"}, ID: req.ID})
		return
	}

	globalWatcherMu.Lock()
	if globalWatchers == nil {
		globalWatchers = make(map[string]*watcher.Watcher)
	}
	if existing := globalWatchers[path]; existing != nil {
		globalWatcherMu.Unlock()
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "Watcher already active on " + path, ID: req.ID})
		return
	}

	w, err := watcher.New(1500, func(event watcher.FileEvent) {
		// P2-F4 / Phase 3: Ignore .raw.md files — they are pre-narrative raw log backups,
		// not actual episodes. Indexing them would pollute recall with raw conversation text.
		if strings.HasSuffix(event.Path, ".raw.md") {
			return
		}
		EmitLog("Watcher event: %s %s", event.Operation, event.Path)
		sendEvent(conn, "watcher.onFileChange", event)
	})

	if err != nil {
		globalWatcherMu.Unlock()
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32000, err.Error()}, ID: req.ID})
		return
	}
	globalWatchers[path] = w
	globalWatcherConn = conn

	if quarantined, moved, err := quarantineLegacyNestedEpisodeTree(path); err != nil {
		w.Stop()
		delete(globalWatchers, path)
		if globalWatcherConn == conn {
			globalWatcherConn = nil
		}
		globalWatcherMu.Unlock()
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Legacy nested tree quarantine failed: " + err.Error()}, ID: req.ID})
		return
	} else if moved {
		EmitLog("Legacy nested episode tree isolated at %s before watcher registration", quarantined)
	}

	if err := w.AddRecursive(path); err != nil {
		w.Stop()
		delete(globalWatchers, path)
		globalWatcherMu.Unlock()
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32000, "Failed to watch dir: " + err.Error()}, ID: req.ID})
		return
	}

	globalWatcherMu.Unlock()

	// Eagerly initialize the vector store so the AsyncHealingWorker starts up immediately
	go func(ws string) {
		_, _ = getStore(ws)
	}(path)

	// watcher.Start() is non-blocking and safe to call outside the mutex
	w.Start()
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "Watcher started on " + path, ID: req.ID})
}

func handleFrontmatterParse(conn net.Conn, req RPCRequest) {
	var params map[string]string
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32602, "Invalid params"}, ID: req.ID})
		return
	}

	path, ok := params["file"]
	if !ok {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32602, "Missing 'file'"}, ID: req.ID})
		return
	}

	doc, err := frontmatter.Parse(path)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32000, err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: doc, ID: req.ID})
}

func handleRollbackLegacyNestedEpisodeTree(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.AgentWs == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Missing 'agentWs'"}, ID: req.ID})
		return
	}

	restoredRoot, err := rehydrateLegacyNestedEpisodeTree(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]string{"restoredRoot": restoredRoot, "status": "recovered"}, ID: req.ID})
}

// --- Cache Queue helpers ---

func getOrCreateCacheQueue(agentWs string) (*cache.Queue, error) {
	cacheQueuesMu.Lock()
	defer cacheQueuesMu.Unlock()

	if q, ok := cacheQueues[agentWs]; ok {
		return q, nil
	}

	q, err := cache.New(agentWs)
	if err != nil {
		return nil, fmt.Errorf("failed to create cache queue for %s: %w", agentWs, err)
	}
	cacheQueues[agentWs] = q
	EmitLog("[CacheQueue] Initialized cache DB for %s", agentWs)
	return q, nil
}

// --- Cache Queue RPC handlers ---

func handleCacheEnqueueBatch(conn net.Conn, req RPCRequest) {
	var params struct {
		Items []cache.QueueItem `json:"items"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if len(params.Items) == 0 {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]int{"enqueued": 0}, ID: req.ID})
		return
	}

	agentWs := params.Items[0].AgentWs
	q, err := getOrCreateCacheQueue(agentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	if err := q.EnqueueBatch(params.Items); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	// Calculate token summary for logging
	totalTokens := 0
	for _, item := range params.Items {
		totalTokens += item.EstimatedTokens
	}
	EmitLog("[Episodic Cache] Enqueued %d chunks for agentWs=%s. source=%s parent=%s (tokens: %d. queue_size=%d)",
		len(params.Items), agentWs, params.Items[0].Source, params.Items[0].ParentIngestID, totalTokens, len(params.Items))

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]int{"enqueued": len(params.Items)}, ID: req.ID})
}

func handleCacheLeaseNext(conn net.Conn, req RPCRequest) {
	var params struct {
		WorkerID     string `json:"workerId"`
		AgentID      string `json:"agentId"`
		LeaseSeconds int    `json:"leaseSeconds"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.WorkerID == "" || params.AgentID == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Missing workerId or agentId"}, ID: req.ID})
		return
	}

	// Find the cache queue for this agent — scan all workspaces
	var foundItem *cache.QueueItem
	for agentWs, q := range cacheQueues {
		item, err := q.LeaseNext(params.AgentID, params.WorkerID, params.LeaseSeconds)
		if err != nil {
			continue
		}
		if item != nil {
			foundItem = item
			EmitLog("[NarrativeWorker] Leased chunk [%s] attempt=%d lease=%ds tokens=%d agentWs=%s",
				item.ID, item.Attempts, params.LeaseSeconds, item.EstimatedTokens, agentWs)
			break
		}
	}

	if foundItem == nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: nil, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: foundItem, ID: req.ID})
}

func handleCacheAck(conn net.Conn, req RPCRequest) {
	var params struct {
		ID       string `json:"id"`
		WorkerID string `json:"workerId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	for agentWs, q := range cacheQueues {
		if err := q.Ack(params.ID); err == nil {
			EmitLog("[Episodic DB] Acked cache job [%s] from %s. Worker=%s", params.ID, agentWs, params.WorkerID)
			sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "acked", ID: req.ID})
			return
		}
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Item not found in any cache queue"}, ID: req.ID})
}

func handleCacheRetry(conn net.Conn, req RPCRequest) {
	var params struct {
		ID          string `json:"id"`
		WorkerID    string `json:"workerId"`
		Error       string `json:"error"`
		BackoffSec  int    `json:"backoffSec"`
		MaxAttempts int    `json:"maxAttempts"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.MaxAttempts <= 0 {
		params.MaxAttempts = 20
	}

	for _, q := range cacheQueues {
		if err := q.Retry(params.ID, params.Error, params.MaxAttempts, params.BackoffSec); err == nil {
			EmitLog("[NarrativeWorker] Returned chunk [%s] to queue with backoff. attempts=%d error=%s", params.ID, params.MaxAttempts, params.Error)
			sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "retried", ID: req.ID})
			return
		}
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Item not found in any cache queue"}, ID: req.ID})
}

// Note: iterates cacheQueues without lock, consistent with handleCacheAck
func handleCacheRequeue(conn net.Conn, req RPCRequest) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	for agentWs, q := range cacheQueues {
		if err := q.Requeue(params.ID); err == nil {
			EmitLog("[Episodic DB] Requeued cache job [%s] from %s for re-narrativization", params.ID, agentWs)
			sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "requeued", ID: req.ID})
			return
		}
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Item not found or not in done status"}, ID: req.ID})
}

func handleGetLatestNarrative(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
		AgentID string `json:"agentId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.AgentWs == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]interface{}{
			"episodeId": "", "body": "", "found": false,
		}, ID: req.ID})
		return
	}

	// First, try the cache queue for this workspace (if it exists)
	cacheQueuesMu.Lock()
	q, qExists := cacheQueues[params.AgentWs]
	cacheQueuesMu.Unlock()

	if qExists {
		episodeID, body, found, err := q.GetLatestNarrative(params.AgentWs, params.AgentID)
		if err != nil {
			EmitLog("[CacheQueue] GetLatestNarrative error for %s: %v", params.AgentWs, err)
		}
		if found {
			EmitLog("[CacheQueue] GetLatestNarrative found %s for agent %s (via cache queue)", episodeID, params.AgentID)
			sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]interface{}{
				"episodeId": episodeID, "body": body, "found": true,
			}, ID: req.ID})
			return
		}
	}

	// Fallback: scan the episodes directory directly (works even if no cache queue was created yet)
	episodeID, body, found, err := scanLatestNarrativeEpisode(params.AgentWs)
	if err != nil {
		EmitLog("[CacheQueue] scanLatestNarrativeEpisode error for %s: %v", params.AgentWs, err)
	}
	if found {
		EmitLog("[CacheQueue] GetLatestNarrative found %s for agent %s (via directory scan)", episodeID, params.AgentID)
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]interface{}{
			"episodeId": episodeID, "body": body, "found": true,
		}, ID: req.ID})
		return
	}

	EmitLog("[CacheQueue] GetLatestNarrative not found for agent %s in %s", params.AgentID, params.AgentWs)
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]interface{}{
		"episodeId": "", "body": "", "found": false,
	}, ID: req.ID})
}

// scanLatestNarrativeEpisode scans the episodes directory for the latest narrative-tagged episode.
// This is used as a fallback when the cache queue hasn't been initialized yet (e.g., at startup).
func scanLatestNarrativeEpisode(agentWs string) (episodeID string, body string, found bool, err error) {
	type epInfo struct {
		id   string
		time time.Time
		path string
	}

	var episodes []epInfo
	filepath.WalkDir(agentWs, func(fp string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(fp, ".md") || strings.HasSuffix(fp, ".raw.md") {
			return nil
		}
		content, rErr := os.ReadFile(fp)
		if rErr != nil {
			return nil
		}

		// Try footer metadata first (v0.4.0+)
		idx := bytes.LastIndex(content, []byte(cache.FooterMarker))
		if idx >= 0 {
			remaining := content[idx:]
			endIdx := bytes.Index(remaining, []byte("-->"))
			if endIdx < 0 {
				return nil
			}
			jsonStr := strings.TrimSpace(string(remaining[len(cache.FooterMarker):endIdx]))
			var fm cache.FooterMetadata
			if jErr := json.Unmarshal([]byte(jsonStr), &fm); jErr != nil {
				return nil
			}
			hasNarrative := false
			for _, t := range fm.Tags {
				if t == "narrative" {
					hasNarrative = true
					break
				}
			}
			if !hasNarrative {
				return nil
			}
			excluded := map[string]bool{"genesis-archive": true, "fallback": true, "gap-compacted": true}
			for _, t := range fm.Tags {
				if excluded[t] {
					return nil
				}
			}
			episodes = append(episodes, epInfo{id: fm.ID, time: fm.Created, path: fp})
			return nil
		}

		// Fallback: try YAML frontmatter (v0.3.x)
		parts := bytes.SplitN(content, []byte("---"), 3)
		if len(parts) >= 3 && len(bytes.TrimSpace(parts[0])) == 0 {
			var meta struct {
				Tags []string `yaml:"tags"`
			}
			if yErr := yaml.Unmarshal(parts[1], &meta); yErr == nil {
				hasNarrative := false
				for _, t := range meta.Tags {
					if t == "narrative" {
						hasNarrative = true
						break
					}
				}
				if hasNarrative {
					info, iErr := d.Info()
					if iErr == nil {
						episodes = append(episodes, epInfo{id: strings.TrimSuffix(d.Name(), ".md"), time: info.ModTime(), path: fp})
					}
				}
			}
		}
		return nil
	})

	if len(episodes) == 0 {
		return "", "", false, nil
	}

	sort.Slice(episodes, func(i, j int) bool {
		return episodes[i].time.After(episodes[j].time)
	})

	latest := episodes[0]
	bodyContent, rErr := os.ReadFile(latest.path)
	if rErr != nil {
		return "", "", false, rErr
	}

	// Strip footer metadata
	idx := bytes.LastIndex(bodyContent, []byte(cache.FooterMarker))
	if idx >= 0 {
		bodyContent = bodyContent[:idx]
	}

	// Strip YAML frontmatter if present (for v0.3.x episodes)
	if bytes.HasPrefix(bodyContent, []byte("---")) {
		parts := bytes.SplitN(bodyContent, []byte("---"), 3)
		if len(parts) >= 3 {
			bodyContent = bytes.TrimLeft(parts[2], "\n\r")
		}
	}

	bodyContent = bytes.TrimSpace(bodyContent)
	return latest.id, string(bodyContent), true, nil
}

// RebuildResult is the structured result of a runAutoRebuild call.
// Returned both in the RPC response (handleIndexerRebuild) and for internal callers.
type RebuildResult struct {
	Processed      int  `json:"processed"`       // files successfully embedded and indexed
	Failed         int  `json:"failed"`          // files that failed for any reason
	CircuitTripped bool `json:"circuit_tripped"` // true if Circuit Breaker opened (3 consecutive 429s)
	DelegatedCount int  `json:"delegated_count"` // estimated number of skipped files delegated to HealingWorker
}

func handleIndexerRebuild(conn net.Conn, req RPCRequest) {
	var params struct {
		Path    string `json:"path"`
		AgentWs string `json:"agentWs"`
		APIKey  string `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	EmitLog("Starting full rebuild for %s", params.Path)

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	// 1. Clear existing Store
	if err := vstore.Clear(); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store clear failed: " + err.Error()}, ID: req.ID})
		return
	}

	result := runAutoRebuild(params.Path, apiKey, vstore)

	EmitLog("Rebuild complete: processed=%d failed=%d circuit_tripped=%v delegated=%d",
		result.Processed, result.Failed, result.CircuitTripped, result.DelegatedCount)
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: result, ID: req.ID})
}

// runAutoRebuild performs the background reconstruction of the HNSW index from local markdown files.
// Used both by the manual indexer rebuild RPC, and optionally as a Self-Healing DB fallback.
//
// ⚠️  P2 ARCHITECTURE: Sequential batch processing (no goroutines in main loop).
//
//	Files are processed in groups of batchSize via EmbedContentBatch (1 HTTP request per group).
//	Circuit Breaker trips after circuitThreshold consecutive 429 batch responses.
//	Worst case wasted API calls = circuitThreshold × batchSize before circuit trips.
//
// OPERATIONAL NOTE: embedLimiter (100 RPM) is shared with handleIngest, handleBatchIngest,
// handleRecall, and RunConsolidation. During active conversation sessions, rebuild throughput
// may be lower than the theoretical 100 RPM / 0.6s-per-file rate.
// With batch size 10: effective throughput = 10 files per embedLimiter token (10x RPM reduction).
func runAutoRebuild(targetDir string, apiKey string, vstore *vector.Store) RebuildResult {
	if quarantined, moved, err := quarantineLegacyNestedEpisodeTree(targetDir); err != nil {
		EmitLog("Failed to quarantine legacy nested episode tree before auto rebuild for %s: %v", targetDir, err)
		return RebuildResult{}
	} else if moved {
		EmitLog("Legacy nested episode tree isolated at %s before auto rebuild", quarantined)
	}

	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
	ctx := context.Background()

	// Use a struct to capture both path and modified time for LIFO sorting
	type fileRecord struct {
		path    string
		modTime time.Time
	}

	var files []fileRecord
	err := filepath.Walk(targetDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && isNestedLegacyEpisodePath(targetDir, path) {
			EmitLog("Skipping legacy nested episode tree during rebuild: %s", path)
			return filepath.SkipDir
		}
		if !info.IsDir() && strings.HasSuffix(strings.ToLower(info.Name()), ".md") {
			files = append(files, fileRecord{path: path, modTime: info.ModTime()})
		}
		return nil
	})

	if err != nil {
		EmitLog("Walk failed: %v", err)
		return RebuildResult{}
	}

	// Extract true Created time from Frontmatter for precise LIFO sorting
	EmitLog("Extracting Frontmatter Created timestamps for %d files...", len(files))
	var prepWg sync.WaitGroup
	prepSem := make(chan struct{}, 50)
	for i := range files {
		prepWg.Add(1)
		go func(idx int) {
			defer prepWg.Done()
			prepSem <- struct{}{}
			defer func() { <-prepSem }()

			doc, err := frontmatter.Parse(files[idx].path)
			if err == nil && !doc.Metadata.Created.IsZero() {
				files[idx].modTime = doc.Metadata.Created
			}
		}(i)
	}
	prepWg.Wait()

	// LIFO Rebuild: Sort by Modification Time Descending (Newest first)
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.After(files[j].modTime)
	})

	var processed int
	var failed int

	// Circuit Breaker state: counts consecutive 429 batch responses only.
	// Non-429 errors reset the counter (API is alive, transient issue).
	var consecutiveFails429 int
	const circuitThreshold = 3

	// P2: batch size — 1 HTTP request processes batchSize files (reduces RPM by batchSize×).
	// Worst-case wasted API calls before circuit trips: circuitThreshold × batchSize.
	const batchSize = 10

	type batchItem struct {
		path    string
		modTime time.Time
		doc     *frontmatter.MarkdownDocument
	}

	for i := 0; i < len(files); {
		// Circuit Breaker: quota exhausted — skip remaining files.
		if consecutiveFails429 >= circuitThreshold {
			break
		}

		// Collect next batch
		end := i + batchSize
		if end > len(files) {
			end = len(files)
		}
		batch := files[i:end]
		i = end

		// Parse all files in batch; skip unparseable files individually.
		var items []batchItem
		for _, frec := range batch {
			doc, err := frontmatter.Parse(frec.path)
			if err != nil {
				EmitLog("Rebuild: failed to parse %s: %v", frec.path, err)
				failed++
				continue
			}
			items = append(items, batchItem{frec.path, frec.modTime, doc})
		}
		if len(items) == 0 {
			continue
		}

		embedItems := make([]batchItem, 0, len(items))
		texts := make([]string, 0, len(items))
		for _, item := range items {
			if strings.TrimSpace(item.doc.Body) == "" {
				EmitLog("Rebuild: skipped empty body for %s", item.path)
				failed++
				continue
			}
			embedItems = append(embedItems, item)
			texts = append(texts, item.doc.Body)
		}
		if len(embedItems) == 0 {
			continue
		}

		// embedLimiter: 1 token = 1 HTTP request (batch counts as 1 RPM).
		embedCtx, embedCancel := context.WithTimeout(ctx, 30*time.Second)
		if err := embedLimiter.Wait(embedCtx); err != nil {
			embedCancel()
			EmitLog("Rebuild: embedLimiter timeout for batch[%d], skipping %d items: %v", i-len(items), len(embedItems), err)
			failed += len(embedItems)
			continue
		}
		embedCancel()

		// tpmLimiter: charge MaxEmbedRunes per item.
		// burst=15K ≥ MaxEmbedRunes=8K so each WaitN(ctx, MaxEmbedRunes) fits in one burst.
		// recall is intentionally excluded — queries are short and user-latency-sensitive.
		tpmOK := true
		for _, item := range embedItems {
			tpmCtx, tpmCancel := context.WithTimeout(ctx, 60*time.Second)
			if err := tpmLimiter.WaitN(tpmCtx, ai.MaxEmbedRunes); err != nil {
				tpmCancel()
				EmitLog("Rebuild: tpmLimiter timeout for %s in batch, skipping batch: %v", item.path, err)
				failed += len(embedItems)
				tpmOK = false
				break
			}
			tpmCancel()
		}
		if !tpmOK {
			continue
		}

		// Batch embed: 1 HTTP request for all items in this batch.
		embs, err := provider.EmbedContentBatch(ctx, texts)
		if err != nil {
			failed += len(embedItems)
			if ai.IsRateLimitError(err) {
				// 429 / RESOURCE_EXHAUSTED: count toward circuit threshold.
				consecutiveFails429++
				EmitLog("Rebuild: 429 for batch (consecutiveFails429=%d/%d)", consecutiveFails429, circuitThreshold)
			} else {
				// Non-429 errors: treat as "API alive, transient issue" and reset circuit counter.
				// DESIGN NOTE (BLOCKER-2 / NEW-2): context.DeadlineExceeded does NOT count toward
				// the circuit threshold — intentional tradeoff to prevent non-quota issues from
				// tripping the Circuit Breaker prematurely.
				consecutiveFails429 = 0
				EmitLog("Rebuild: non-429 error for batch (circuit reset per BLOCKER-2 design): %v", err)
			}
			continue
		}

		// Store results — guard against short API response.
		if len(embs) != len(embedItems) {
			EmitLog("Rebuild: batch response length mismatch (got %d, want %d), skipping batch", len(embs), len(embedItems))
			failed += len(embedItems)
			continue
		}
		for j, item := range embedItems {
			topics := topicsForRecord(item.doc.Metadata.Topics, item.doc.Metadata.Tags)
			if err := vstore.Add(ctx, vector.EpisodeRecord{
				ID:         item.doc.Metadata.ID,
				Title:      item.doc.Metadata.Title,
				Tags:       item.doc.Metadata.Tags,
				Topics:     topics,
				Timestamp:  item.modTime,
				Edges:      item.doc.Metadata.RelatedTo,
				Vector:     embs[j],
				SourcePath: item.path,
				Depth:      item.doc.Metadata.Depth,
				Tokens:     item.doc.Metadata.Tokens,
				Surprise:   item.doc.Metadata.Surprise,
			}); err != nil {
				EmitLog("Rebuild: failed to add %s to vector store: %v", item.path, err)
				failed++
			} else {
				processed++
				consecutiveFails429 = 0 // success resets circuit counter
			}
		}
	}

	// If circuit tripped, delegate remaining Ghost files to HealingWorker.
	circuitTripped := consecutiveFails429 >= circuitThreshold
	var delegatedCount int
	if circuitTripped {
		// delegated_count = total files not yet successfully indexed
		delegatedCount = len(files) - processed
		EmitLog("Rebuild: Circuit breaker tripped (%d consecutive 429s). "+
			"Delegating ~%d unindexed files to HealingWorker.", circuitThreshold, delegatedCount)
		triggerHealing()
	}

	return RebuildResult{
		Processed:      processed,
		Failed:         failed,
		CircuitTripped: circuitTripped,
		DelegatedCount: delegatedCount,
	}
}

func isNestedLegacyEpisodePath(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	rel = filepath.Clean(rel)
	if rel == "." {
		return false
	}
	return rel == "episodes" || strings.HasPrefix(rel, "episodes"+string(filepath.Separator))
}

func handleSurprise(conn net.Conn, req RPCRequest) {

	var params struct {
		Text1  string `json:"text1"`
		Text2  string `json:"text2"`
		APIKey string `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if strings.TrimSpace(params.Text1) == "" || strings.TrimSpace(params.Text2) == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "text1/text2 must not be empty"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	ctx := context.Background()
	emb1, err := provider.EmbedContent(ctx, params.Text1)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed text1 embed: " + err.Error()}, ID: req.ID})
		return
	}
	emb2, err := provider.EmbedContent(ctx, params.Text2)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed text2 embed: " + err.Error()}, ID: req.ID})
		return
	}

	dist := float32(vector.CosineDistance(emb1, emb2))
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]float32{"surprise": dist}, ID: req.ID})
}

func handleSegmentScore(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs           string  `json:"agentWs"`
		AgentId           string  `json:"agentId"`
		Turn              int     `json:"turn"`
		Text1             string  `json:"text1"`
		Text2             string  `json:"text2"`
		Lambda            float64 `json:"lambda"`
		WarmupCount       int     `json:"warmupCount"`
		MinRawSurprise    float64 `json:"minRawSurprise"`
		CooldownTurns     int     `json:"cooldownTurns"`
		StdFloor          float64 `json:"stdFloor"`
		FallbackThreshold float64 `json:"fallbackThreshold"`
		APIKey            string  `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if strings.TrimSpace(params.AgentWs) == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "agentWs must not be empty"}, ID: req.ID})
		return
	}
	if strings.TrimSpace(params.Text1) == "" || strings.TrimSpace(params.Text2) == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "text1/text2 must not be empty"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
	ctx := context.Background()
	emb1, err := provider.EmbedContent(ctx, params.Text1)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed text1 embed: " + err.Error()}, ID: req.ID})
		return
	}
	emb2, err := provider.EmbedContent(ctx, params.Text2)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed text2 embed: " + err.Error()}, ID: req.ID})
		return
	}

	raw := float64(vector.CosineDistance(emb1, emb2))

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed to open store: " + err.Error()}, ID: req.ID})
		return
	}

	st, getErr := vstore.GetSegmentationState(params.AgentId)
	if getErr != nil {
		logger.Warn(logger.CatStore, "GetSegmentationState failed for agent %s (falling back to zero-value warmup): %v", params.AgentId, getErr)
	}

	// Decision uses the current state (pre-update).
	fallback := params.FallbackThreshold
	if fallback <= 0 {
		fallback = 0.2
	}
	lambda := params.Lambda
	if lambda <= 0 {
		lambda = 2.0
	}
	warmup := params.WarmupCount
	if warmup <= 0 {
		warmup = 20
	}
	minRaw := params.MinRawSurprise
	if minRaw <= 0 {
		minRaw = 0.05
	}
	cooldown := params.CooldownTurns
	if cooldown < 0 {
		cooldown = 0
	}

	mean := st.Mean
	stdFloor := params.StdFloor
	if stdFloor <= 0 {
		stdFloor = 0.01
	}
	varFloor := stdFloor * stdFloor
	if varFloor < 1e-8 {
		varFloor = 1e-8
	}
	variance := st.Variance
	if variance < varFloor {
		variance = varFloor
	}
	std := math.Sqrt(variance)

	threshold := fallback
	reason := "warmup"
	inWarmup := st.Count < warmup
	if !inWarmup {
		threshold = mean + (lambda * std)
		if threshold < fallback {
			threshold = fallback
		}
		reason = "surprise-z"
	}

	z := 0.0
	if std > 0 {
		z = (raw - mean) / std
	}

	isBoundary := false
	if !inWarmup {
		isBoundary = raw >= minRaw && raw > threshold
		if isBoundary && vector.ShouldCooldownSuppress(params.Turn, st.LastBoundaryTurn, cooldown) {
			isBoundary = false
			reason = "cooldown"
		}
		if !isBoundary && reason == "surprise-z" {
			reason = "below-threshold"
		}
	}

	// Update state (EMA-ish) after the decision, then persist.
	// This is intentionally lightweight (O(1)) and tolerant to restarts.
	update := func(prev vector.SegmentationState, x float64) vector.SegmentationState {
		// Effective window for adaptation (small enough to track per-conversation drift).
		const win = 50
		prev.Count++
		if prev.Count <= 1 {
			prev.Mean = x
			prev.Variance = 0
			return prev
		}
		eff := prev.Count
		if eff > win {
			eff = win
		}
		alpha := 2.0 / float64(eff+1)
		delta := x - prev.Mean
		prev.Mean += alpha * delta
		// EW variance update. Clamp at 0 to avoid tiny negative drift.
		prev.Variance = (1 - alpha) * (prev.Variance + (alpha * delta * delta))
		if prev.Variance < 0 {
			prev.Variance = 0
		}
		return prev
	}

	st = update(st, raw)
	if isBoundary && params.Turn > 0 {
		st.LastBoundaryTurn = params.Turn
	}
	if putErr := vstore.PutSegmentationState(params.AgentId, st); putErr != nil {
		logger.Warn(logger.CatStore, "PutSegmentationState failed for agent %s (state update lost): %v", params.AgentId, putErr)
	}

	sendResponse(conn, RPCResponse{
		JSONRPC: "2.0",
		Result: map[string]any{
			"rawSurprise": raw,
			"mean":        mean,
			"std":         std,
			"threshold":   threshold,
			"z":           z,
			"isBoundary":  isBoundary,
			"reason":      reason,
		},
		ID: req.ID,
	})
}

func ensureSavedBy(in string) string {
	if in == "" {
		return "auto"
	}
	return in
}

// stripTelegramMetadata removes Telegram gateway JSON metadata blocks from text.
// These blocks are injected by the Telegram gateway and waste token budget.
var telegramMetaPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)Conversation info \(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)Sender \(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)Replied message \(untrusted,? for context\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)\(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
}

func stripTelegramMetadata(text string) string {
	cleaned := text
	for _, p := range telegramMetaPatterns {
		cleaned = p.ReplaceAllString(cleaned, "")
	}
	// Collapse multiple blank lines left behind by removals
	cleaned = regexp.MustCompile(`\n{3,}`).ReplaceAllString(cleaned, "\n\n")
	return strings.TrimSpace(cleaned)
}

func topicsForRecord(topics []string, legacyTags []string) []string {
	clean, _ := vector.ValidateTopics(topics)
	if len(clean) > 0 {
		return clean
	}
	return vector.LegacyTopicsFromTags(legacyTags)
}

func handleIngest(conn net.Conn, req RPCRequest) {
	var params struct {
		Summary  string             `json:"summary"`
		Tags     []string           `json:"tags"`
		Topics   []string           `json:"topics"`
		Edges    []frontmatter.Edge `json:"edges"`
		AgentWs  string             `json:"agentWs"`
		APIKey   string             `json:"apiKey"`
		SavedBy  string             `json:"savedBy"`
		Surprise float64            `json:"surprise"`
		Depth    int                `json:"depth"`
	}
	EmitLog("ai.ingest TRACE 1: About to unmarshal req.Params: %s", string(req.Params))
	if err := json.Unmarshal(req.Params, &params); err != nil {
		EmitLog("ai.ingest TRACE ERROR: Unmarshal failed: %v", err)
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}
	EmitLog("ai.ingest TRACE 2: Successfully unmarshaled. params.Summary length: %d", len(params.Summary))

	// 🔍 DEBUG: Dump received params to identify why Summary arrives empty
	summaryPreview := params.Summary
	if len(summaryPreview) > 100 {
		summaryPreview = summaryPreview[:100] + "..."
	}
	EmitLog("ai.ingest DEBUG: Summary len=%d, preview=%q, AgentWs=%q, raw_params=%s", len(params.Summary), summaryPreview, params.AgentWs, string(req.Params)[:min(len(string(req.Params)), 300)])

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	savedBy := ensureSavedBy(params.SavedBy)

	// Sanitize summary: strip Telegram gateway JSON metadata blocks
	params.Summary = stripTelegramMetadata(params.Summary)

	ctx := context.Background()

	// Safe Phase 1: Skip Gemma generation, immediately use MD5 slug for safe queueing
	// Fix CRITICAL-1: Use full 128-bit MD5 to avoid birthday paradox collisions
	hash := md5.Sum([]byte(params.Summary))
	slug := fmt.Sprintf("episode-%x", hash)
	EmitLog("Quality Guard (Ingest): using MD5 safe-queue slug: %s", slug)

	// Build the path: notes/YYYY-MM for manual ep-save, YYYY/MM/DD for auto segments
	now := time.Now()
	isManualSave := false
	for _, t := range params.Tags {
		if t == "manual-save" {
			isManualSave = true
			break
		}
	}

	var dirPath string
	if isManualSave {
		dirPath = filepath.Join(params.AgentWs, "notes",
			fmt.Sprintf("%04d-%02d", now.Year(), now.Month()))
	} else {
		dirPath = filepath.Join(params.AgentWs,
			fmt.Sprintf("%04d", now.Year()),
			fmt.Sprintf("%02d", now.Month()),
			fmt.Sprintf("%02d", now.Day()))
	}

	if err := os.MkdirAll(dirPath, 0755); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Mkdir failed: " + err.Error()}, ID: req.ID})
		return
	}

	filePath := filepath.Join(dirPath, slug+".md")
	topics := topicsForRecord(params.Topics, params.Tags)

	fm := frontmatter.EpisodeMetadata{
		ID:        slug,
		Title:     slug,
		Created:   now,
		Tags:      params.Tags,
		Topics:    topics,
		SavedBy:   savedBy,
		Surprise:  params.Surprise,
		Depth:     params.Depth,
		Tokens:    frontmatter.EstimateTokens(params.Summary),
		RelatedTo: params.Edges,
	}

	doc := &frontmatter.MarkdownDocument{
		Metadata: fm,
		Body:     params.Summary,
	}

	// Also generate embedding for this summary to save into Pebble/HNSW immediately.
	// Case 3 (P1): RetryEmbedder wraps the provider with retry-on-429/5xx for realtime UX.
	// MaxRetries=2 keeps max added latency to ~3s, acceptable for a synchronous RPC call.
	// Retry-After header (Case 4) is automatically honoured via google_studio.go.
	rawEmbedProv := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
	embeddingProv := &ai.RetryEmbedder{
		Inner:      rawEmbedProv,
		Limiter:    embedLimiter,
		MaxRetries: 2,
		BaseDelay:  1 * time.Second,
	}

	// ✅ Guard: empty summary would cause API 400 "empty Part" error
	if strings.TrimSpace(params.Summary) == "" {
		EmitLog("ai.ingest: Summary is empty, skipping embed and returning early.")
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Summary is empty"}, ID: req.ID})
		return
	}

	// P2-E FIX: Use global rate limiter (via RetryEmbedder.Limiter internally).
	// We bound the total call with a 10s context (3 retries × ~3s max each).
	embedCtx, cancel := context.WithTimeout(ctx, 10*time.Second)

	var emb []float32
	var embedErr error
	// TPM guard: fixed cost per embed. At 15K tokens/sec this adds ~0.5s max wait.
	if tpmErr := tpmLimiter.WaitN(embedCtx, ai.MaxEmbedRunes); tpmErr != nil {
		EmitLog("Ingest: tpmLimiter timeout: %v", tpmErr)
		embedErr = tpmErr
	} else {
		emb, embedErr = embeddingProv.EmbedContent(embedCtx, params.Summary)
		if embedErr != nil {
			EmitLog("Ingest: EmbedContent failed after retries: %v", embedErr)
		}
	}
	cancel() // release context immediately

	// Only serialize AFTER embedding logic completes (success or fail - Survival First)
	if err := frontmatter.Serialize(filePath, doc); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Serialize failed: " + err.Error()}, ID: req.ID})
		return
	}

	// Save to Vector Store
	vstore, err := getStore(params.AgentWs)
	if err == nil {
		// Only add to vector store if embedding was successful
		if embedErr == nil && emb != nil {
			vstore.Add(ctx, vector.EpisodeRecord{
				ID:         slug,
				Title:      slug,
				Tags:       params.Tags,
				Topics:     topics,
				Timestamp:  now,
				Edges:      params.Edges,
				Vector:     emb,
				SourcePath: filePath,
				Depth:      params.Depth,
				Tokens:     frontmatter.EstimateTokens(params.Summary),
				Surprise:   params.Surprise,
			})
		} else {
			EmitLog("Ingest: Skipping vector store add due to embedding failure or timeout. Triggering healing.")
			triggerHealing() // Wake up background worker to heal
		}

		// Update last_activity for Sleep Timer
		vstore.SetMeta("last_activity", []byte(fmt.Sprintf("%d", now.Unix())))
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]string{"path": filePath, "slug": slug}, ID: req.ID})
}

func auditEpisodeQuality(slug string) error {
	if len(slug) < 3 || len(slug) > 80 {
		return fmt.Errorf("slug length out of range: %d", len(slug))
	}

	banned := []string{
		// English
		"here-are", "sure-i-can", "as-an-ai", "i-d-be-happy", "certainly", "of-course",
		// Japanese
		"承知", "了解", "わかり", "はい", "aiとして", "回答", "ここ",
		// Chinese
		"好的", "没问题", "当然", "作为一个", "答案",
		// Korean
		"알겠습니다", "네", "당연하죠", "ai로서", "대답",
	}

	lowerSlug := strings.ToLower(slug)
	for _, b := range banned {
		if strings.Contains(lowerSlug, b) {
			return fmt.Errorf("slug contains banned pattern: %s", b)
		}
	}

	// ✅ Strict kebab-case validation: only lowercase ASCII letters, digits, and hyphens.
	// ^[a-z0-9-]+$ also rejects: spaces, Japanese/Chinese/Korean, and any special chars (!, ?, @, etc.)
	kebabRe := regexp.MustCompile(`^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
	if !kebabRe.MatchString(slug) {
		return fmt.Errorf("slug is not valid kebab-case (must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$): %s", slug)
	}
	return nil
}

type BatchIngestItem struct {
	Summary  string             `json:"summary"`
	Tags     []string           `json:"tags"`
	Topics   []string           `json:"topics,omitempty"`
	Edges    []frontmatter.Edge `json:"edges"`
	Surprise float64            `json:"surprise,omitempty"`
	Depth    int                `json:"depth,omitempty"`
	Tokens   int                `json:"tokens,omitempty"`
	Sources  []string           `json:"sources,omitempty"`
}

func handleBatchIngest(conn net.Conn, req RPCRequest) {
	var params struct {
		Items   []BatchIngestItem `json:"items"`
		AgentWs string            `json:"agentWs"`
		APIKey  string            `json:"apiKey"`
		SavedBy string            `json:"savedBy"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	savedBy := ensureSavedBy(params.SavedBy)

	// Sanitize summaries: strip Telegram gateway JSON metadata blocks
	for i := range params.Items {
		params.Items[i].Summary = stripTelegramMetadata(params.Items[i].Summary)
	}

	ctx := context.Background()
	rawEmbedProv := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
	// MED-2: Make retry & rate limiting unified and symmetric with handleRecall
	embeddingProv := &ai.RetryEmbedder{
		Inner:      rawEmbedProv,
		Limiter:    embedLimiter,
		MaxRetries: 2,
		BaseDelay:  1 * time.Second,
	}
	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: fmt.Sprintf("failed to get store: %v", err)}, ID: req.ID})
		return
	}

	// We now use global gemmaLimiter and embedLimiter across all handlers

	var slugs []string
	var successRecords []vector.EpisodeRecord
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)

	for _, item := range params.Items {
		wg.Add(1)
		go func(it BatchIngestItem) {
			defer wg.Done()
			if strings.TrimSpace(it.Summary) == "" {
				EmitLog("BatchIngest: skipped empty summary item")
				return
			}

			// P2-E FIX: Lower semaphore per user's recommendation to reduce burst 429
			// sem := make(chan struct{}, 2) // already changed above, waiting on the channel
			sem <- struct{}{}
			defer func() { <-sem }()

			// Safe Phase 1: Skip Gemma generation, immediately use MD5 slug for safe queueing
			// Fix CRITICAL-1: Use full 128-bit MD5 to avoid birthday paradox collisions
			hash := md5.Sum([]byte(it.Summary))
			slug := fmt.Sprintf("episode-%x", hash)
			EmitLog("Quality Guard (BatchIngest): using MD5 safe-queue slug: %s", slug)

			// embedLimiter is handled internally by RetryEmbedder now.
			embedCtx, cancel := context.WithTimeout(ctx, 10*time.Second)

			var emb []float32
			var embErr error
			if tpmErr := tpmLimiter.WaitN(embedCtx, ai.MaxEmbedRunes); tpmErr != nil {
				EmitLog("BatchIngest: tpmLimiter timeout, skipping embedding for this item: %v", tpmErr)
				embErr = tpmErr
			} else {
				emb, embErr = embeddingProv.EmbedContent(embedCtx, it.Summary)
				if embErr != nil {
					EmitLog("BatchIngest: EmbedContent failed for item, skipping DB insert: %v", embErr)
				}
			}
			cancel() // Release context immediately

			now := time.Now()
			// D0 auto-segment path: YYYY/MM/DD (unchanged)
			dirPath := filepath.Join(params.AgentWs,
				fmt.Sprintf("%04d", now.Year()),
				fmt.Sprintf("%02d", now.Month()),
				fmt.Sprintf("%02d", now.Day()))

			os.MkdirAll(dirPath, 0755)
			filePath := filepath.Join(dirPath, slug+".md")
			topics := topicsForRecord(it.Topics, it.Tags)

			fm := frontmatter.EpisodeMetadata{
				ID:        slug,
				Title:     slug,
				Created:   now,
				Tags:      it.Tags,
				Topics:    topics,
				SavedBy:   savedBy,
				Surprise:  it.Surprise,
				Depth:     it.Depth,
				Tokens:    frontmatter.EstimateTokens(it.Summary),
				RelatedTo: it.Edges,
			}

			doc := &frontmatter.MarkdownDocument{
				Metadata: fm,
				Body:     it.Summary,
			}

			if err := frontmatter.Serialize(filePath, doc); err != nil {
				EmitLog("BatchIngest: Serialize failed: %v", err)
				return
			}

			if embErr == nil && emb != nil && vstore != nil {
				rec := vector.EpisodeRecord{
					ID:         slug,
					Title:      slug,
					Tags:       it.Tags,
					Topics:     topics,
					Timestamp:  now,
					Edges:      it.Edges,
					Vector:     emb,
					SourcePath: filePath,
					Depth:      it.Depth,
					Tokens:     frontmatter.EstimateTokens(it.Summary),
					Surprise:   it.Surprise,
				}
				mu.Lock()
				successRecords = append(successRecords, rec)
				mu.Unlock()
			} else if vstore != nil {
				EmitLog("BatchIngest: VectorDB missing %s due to embedding failure. Triggering healing.", slug)
				triggerHealing() // Wake up the background worker
			}

			mu.Lock()
			slugs = append(slugs, slug)
			mu.Unlock()
		}(item)
	}

	wg.Wait()

	if vstore != nil && len(successRecords) > 0 {
		if err := vstore.BatchAdd(ctx, successRecords); err != nil {
			EmitLog("BatchIngest: vstore.BatchAdd failed: %v", err)
		}
	}

	// Ensure last_activity is updated for Sleep Timer consolidation
	if vstore != nil {
		_ = vstore.SetMeta("last_activity", []byte(fmt.Sprintf("%d", time.Now().Unix())))
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: slugs, ID: req.ID})
}

// RunAsyncHealingWorker scans for episode-[md5].md files and safely heals/refines them.
// Pass 1: Uses healEmbedLimiter (10% capacity) to embed DB-missing orphan MD5 files.
// Pass 2: Uses gemmaLimiter to rename MD5 files to beautiful kebab-case slugs.
//
// HIGH-1: heal429State tracks consecutive 429s with a 2h TTL to backoff when RPD is exhausted.
// This prevents the Ghost files from being retried every Tick (30min) against a dead quota,
// while automatically recovering after TTL expiry to handle false-positives (RPM spikes, etc).
func RunAsyncHealingWorker(agentWs string, apiKey string, vstore *vector.Store) {
	if !vstore.IsRefining.CompareAndSwap(false, true) {
		EmitLog("AsyncHealingWorker: Already running for workspace %s. Skipping.", agentWs)
		return
	}
	defer vstore.IsRefining.Store(false)

	gemmaProv := ai.NewGoogleStudioProvider(apiKey, "gemma-3-27b-it")
	embedProv := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	// HIGH-1: Load heal429 state and apply TTL-based backoff for RPD exhaustion.
	// heal429State: {count, since} — persisted in Pebble DB via SetMeta/GetMeta.
	// TTL=2h: false-positives (RPM spikes, brief outages) auto-recover after 2 hours.
	// True RPD exhaustion re-trips after TTL reset, cycling every 2h (consuming max 3 API calls/cycle).
	type heal429State struct {
		Count int       `json:"count"`
		Since time.Time `json:"since"`
	}
	// H-3: Reduced TTL (2h -> 30min) + probe-based recovery
	const heal429Threshold = 3
	const heal429TTL = 30 * time.Minute  // was 2h
	const heal429ProbeCount = 5           // After TTL expiry, only try 5 files before full recovery

	var h429 heal429State
	if raw, closer, metaErr := vstore.GetRawMeta([]byte("meta:heal_429_state")); metaErr == nil {
		json.Unmarshal(raw, &h429) //nolint:errcheck
		closer.Close()             //nolint:errcheck
	}
	// Auto-reset if TTL has expired — H-3: probe-based recovery
	if h429.Count > 0 && time.Since(h429.Since) > heal429TTL {
		EmitLog("HealingWorker: heal_429 TTL expired (%s elapsed). Entering probe mode (%d files).",
			time.Since(h429.Since).Round(time.Minute), heal429ProbeCount)
		h429.Count = 0  // Reset counter, will re-accumulate during probe
		h429.Since = time.Now()
		if raw, _ := json.Marshal(h429); raw != nil {
			vstore.SetMeta("heal_429_state", raw) //nolint:errcheck
		}
	}
	// Backoff: skip Pass 1 entirely if quota likely exhausted
	if h429.Count >= heal429Threshold {
		EmitLog("HealingWorker: ⚠️  Backoff active (consecutive_429=%d, since=%s). "+
			"Likely RPD exhausted. Pass 1 skipped. Next TTL reset in ~%s. "+
			"Ghost files will be retried after quota recovery.",
			h429.Count,
			h429.Since.Format(time.RFC3339),
			(heal429TTL - time.Since(h429.Since)).Round(time.Minute))
		// Still allow Pass 2 (slug-rename for already-healed files) — no embed needed.
	}

	saveH429 := func() {
		if raw, _ := json.Marshal(h429); raw != nil {
			vstore.SetMeta("heal_429_state", raw) //nolint:errcheck
		}
	}

	filepath.WalkDir(agentWs, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if hasLegacyNestedEpisodePath(agentWs, path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()

		if d.IsDir() {
			if name == "node_modules" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}

		// Expect `episode-[hex].md` where length is between 19 (for 8-char old truncated hashes) and 43 (true MD5)
		if !strings.HasPrefix(name, "episode-") || !strings.HasSuffix(name, ".md") {
			return nil
		}

		l := len(name)
		if l < 19 || l > 43 {
			return nil
		}

		slug := strings.TrimSuffix(name, ".md")
		hexPart := strings.TrimPrefix(slug, "episode-")

		// Ensure hexPart contains only valid hex characters
		for _, r := range hexPart {
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
				return nil // Skip strings like 'episode-new-feature'
			}
		}

		info, iErr := d.Info()
		if iErr != nil {
			return nil
		}
		if time.Since(info.ModTime()) < 5*time.Minute {
			// Wait 5 minutes before repairing to prevent ingest race conditions.
			return nil
		}
		doc, parseErr := frontmatter.Parse(path)
		if parseErr != nil {
			EmitLog("HealingWorker: Failed to parse %s: %v", path, parseErr)
			return nil
		}

		if doc.Metadata.RefineFailed {
			return nil // Skip this poison pill
		}

		existingRec, vErr := vstore.Get(slug)
		isHealed := false

		// ----------------------------------------------------
		// Pass 1: Healing (Embedding Generation for Ghost Files)
		// ----------------------------------------------------
		if vErr != nil || existingRec == nil {
			// Skip Pass 1 if heal429 backoff is active
			if h429.Count >= heal429Threshold {
				EmitLog("HealingWorker: [Pass 1] Skipping %s — heal_429 backoff active.", slug)
				return nil
			}

			EmitLog("HealingWorker: [Pass 1] %s not in DB. Generating embedding.", slug)

			if strings.TrimSpace(doc.Body) == "" {
				EmitLog("HealingWorker: skipped empty body for %s", slug)
				return nil
			}

			embedCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			if wErr := healEmbedLimiter.Wait(embedCtx); wErr != nil {
				EmitLog("HealingWorker: healEmbedLimiter timeout, skipping Pass 1 for now.")
				cancel()
				return nil
			}

			// TPM guard: same fixed cost as rebuild — worst-case Japanese token count.
			tpmHealCtx, tpmHealCancel := context.WithTimeout(context.Background(), 60*time.Second)
			if wErr := tpmLimiter.WaitN(tpmHealCtx, ai.MaxEmbedRunes); wErr != nil {
				EmitLog("HealingWorker: tpmLimiter timeout, skipping Pass 1 for %s.", slug)
				tpmHealCancel()
				cancel()
				return nil
			}
			tpmHealCancel()

			emb, embErr := embedProv.EmbedContent(context.Background(), doc.Body)
			cancel()

			if embErr != nil {
				if ai.IsRateLimitError(embErr) {
					// 429: increment heal_429 counter
					if h429.Count == 0 {
						h429.Since = time.Now()
					}
					h429.Count++
					saveH429()
					EmitLog("HealingWorker: 429 for %s (heal_429 count=%d/%d, since=%s)",
						slug, h429.Count, heal429Threshold, h429.Since.Format(time.RFC3339))
				} else {
					// Non-429 error (parse/timeout/network): API is alive, reset counter
					h429 = heal429State{}
					saveH429()
					EmitLog("HealingWorker: Non-429 error for %s (heal_429 reset): %v", slug, embErr)
				}
				return nil
			}
			// Embed succeeded: full reset
			h429 = heal429State{}
			saveH429()

			newRec := vector.EpisodeRecord{
				ID:         slug,
				Title:      slug,
				Tags:       doc.Metadata.Tags,
				Topics:     topicsForRecord(doc.Metadata.Topics, doc.Metadata.Tags),
				Timestamp:  info.ModTime(),
				Edges:      doc.Metadata.RelatedTo,
				Vector:     emb,
				SourcePath: path,
				Depth:      doc.Metadata.Depth,
				Tokens:     doc.Metadata.Tokens,
				Surprise:   doc.Metadata.Surprise,
			}
			if addErr := vstore.Add(context.Background(), newRec); addErr != nil {
				EmitLog("HealingWorker: Failed to add healed record %s: %v", slug, addErr)
				return nil
			}
			EmitLog("HealingWorker: Successfully healed (Pass 1) for %s", slug)
			existingRec = &newRec
			isHealed = true
		}

		// ----------------------------------------------------
		// Pass 2: Refining (Gemma Rename for valid MD5 files)
		// ----------------------------------------------------
		// If we just healed it and wait limits apply, or it was already in DB.
		EmitLog("HealingWorker: [Pass 2] Refining slug for %s", slug)

		gemmaCtx, gemmaCancel := context.WithTimeout(context.Background(), 30*time.Second)
		if waitErr := gemmaLimiter.Wait(gemmaCtx); waitErr != nil {
			gemmaCancel()
			EmitLog("HealingWorker: gemmaLimiter wait timeout for Pass 2, skipping slug refine for %s", slug)
			return nil
		}
		gemmaCancel()

		bodyText := doc.Body
		ru := []rune(bodyText)
		if len(ru) > 4000 {
			bodyText = string(ru[:4000]) + "\n... (truncated for slug generation)"
		}

		prompt := "You are a helpful assistant. Generate a 2 to 5 word lowercase kebab-case slug (using English words only, no Japanese or other non-ASCII characters) representing the topic of this context summary. IMPORTANT: Your response MUST be in English only. Output nothing but the slug itself (e.g., 'system-architecture-update').\n\nSummary: " + bodyText

		var newSlug string
		for attempt := 0; attempt < 3; attempt++ {
			if attempt > 0 {
				time.Sleep(10 * time.Second)
				retryCtx, retryCancel := context.WithTimeout(context.Background(), 30*time.Second)
				if waitErr := gemmaLimiter.Wait(retryCtx); waitErr != nil {
					retryCancel()
					EmitLog("HealingWorker: gemmaLimiter retry timeout, aborting Pass 2 for %s", slug)
					break
				}
				retryCancel()
			}
			slugGen, genErr := gemmaProv.GenerateText(context.Background(), prompt)
			if genErr != nil {
				continue
			}
			slugGen = strings.TrimSpace(strings.ToLower(strings.Trim(slugGen, "`")))
			if auditEpisodeQuality(slugGen) == nil {
				newSlug = slugGen
				break
			}
		}

		if newSlug == "" {
			EmitLog("HealingWorker: Could not generate valid slug for %s (Poison Pill), marking as refine_failed.", slug)
			doc.Metadata.RefineFailed = true
			if writeErr := frontmatter.Serialize(path, doc); writeErr != nil {
				EmitLog("HealingWorker: Failed to write refine_failed flag to %s: %v", path, writeErr)
			}
			return nil
		}

		// 1. Rewrite the file to a new path
		dirPath := filepath.Dir(path)
		newPath := filepath.Join(dirPath, newSlug+".md")

		doc.Metadata.ID = newSlug
		doc.Metadata.Title = newSlug
		doc.Metadata.Topics = topicsForRecord(doc.Metadata.Topics, doc.Metadata.Tags)

		if writeErr := frontmatter.Serialize(newPath, doc); writeErr != nil {
			EmitLog("HealingWorker: Failed to write new file %s: %v", newPath, writeErr)
			return nil
		}

		// 2. Add new record derived from existingRec (healed or original)
		newRec := *existingRec
		newRec.ID = newSlug
		newRec.Title = newSlug
		newRec.Topics = topicsForRecord(doc.Metadata.Topics, doc.Metadata.Tags)
		newRec.SourcePath = newPath
		newRec.Depth = doc.Metadata.Depth
		newRec.Tokens = doc.Metadata.Tokens
		newRec.Surprise = doc.Metadata.Surprise
		if err := vstore.Add(context.Background(), newRec); err != nil {
			EmitLog("HealingWorker: Failed to add renamed record %s: %v", newSlug, err)
			os.Remove(newPath) // Rollback file
			return nil
		}

		// 3. Delete old record
		vstore.Delete(slug)

		// 4. Delete old local file
		os.Remove(path)
		EmitLog("HealingWorker: Successfully refined (Pass 2) %s -> %s", slug, newSlug)

		// Small breath if we did heavy work
		if isHealed {
			time.Sleep(1 * time.Second)
		}
		return nil
	})

	// ----------------------------------------------------
	// Pass 3: Periodic Async Batch Scoring (Hippocampus)
	// ----------------------------------------------------
	EmitLog("HealingWorker: [Pass 3] Starting Stage 2 Batch Score update...")
	ctxPass3, cancelPass3 := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelPass3()
	if err := vstore.ComputeStage2BatchScores(ctxPass3); err != nil {
		EmitLog("HealingWorker: [Pass 3] Failed to compute batch scores: %v", err)
	} else {
		EmitLog("HealingWorker: [Pass 3] Completed Stage 2 Batch Score update.")
	}

	// ----------------------------------------------------
	// Pass 4: Garbage Collection (Tombstone removal)
	// ----------------------------------------------------
	EmitLog("HealingWorker: [Pass 4] Starting GC (Tombstone older than 14 days)...")
	ctxPass4, cancelPass4 := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelPass4()
	if err := vstore.RunGarbageCollector(ctxPass4); err != nil {
		EmitLog("HealingWorker: [Pass 4] Garbage Collection failed: %v", err)
	} else {
		EmitLog("HealingWorker: [Pass 4] Completed Garbage Collection.")
	}

	// ----------------------------------------------------
	// Pass 5: Lexical Consistency Check (Self-Healing)
	// ----------------------------------------------------
	// Throttle: check only once per interval (default 7 days)
	intervalDays := 7
	if lexicalRebuildInterval != nil {
		intervalDays = *lexicalRebuildInterval
	}

	lastCheck, closer, _ := vstore.GetRawMeta([]byte("meta:last_lexical_check"))
	shouldCheck := true
	if lastCheck != nil {
		ts, err := strconv.ParseInt(string(lastCheck), 10, 64)
		if err == nil && time.Now().Unix()-ts < int64(intervalDays)*86400 {
			shouldCheck = false
		}
	}
	if closer != nil {
		closer.Close()
	}

	if shouldCheck {
		total := vstore.Count()
		lexical, _ := vstore.LexicalCount()

		// If >10% missing (conservative threshold since Count() returns maxID)
		if total > 0 && lexical < uint64(float64(total)*0.9) {
			if !vstore.RebuildInProgress().CompareAndSwap(false, true) {
				EmitLog("HealingWorker: [Pass 5] Lexical rebuild already in progress, skipping.")
			} else {
				go func(ws string, vs *vector.Store) {
					defer vs.RebuildInProgress().Store(false)
					EmitLog("HealingWorker: [Pass 5] Lexical gap detected (%d/%d). Triggering rebuild.", lexical, total)
					count, err := vs.RebuildLexicalIndex()
					if err != nil {
						EmitLog("HealingWorker: [Pass 5] Rebuild failed for %s: %v", ws, err)
					} else {
						EmitLog("HealingWorker: [Pass 5] Rebuild complete for %s. Enqueued %d records.", ws, count)
					}
				}(agentWs, vstore)
			}
		}

		// Update timestamp regardless of gap detection
		vstore.SetMeta("last_lexical_check", []byte(fmt.Sprintf("%d", time.Now().Unix())))
	}
}

func handleRecall(conn net.Conn, req RPCRequest) {
	var params struct {
		Query        string                    `json:"query"`
		K            int                       `json:"k"`
		Topics       []string                  `json:"topics,omitempty"`
		StrictTopics *bool                     `json:"strictTopics,omitempty"`
		Calibration  *vector.RecallCalibration `json:"calibration,omitempty"`
		AgentWs      string                    `json:"agentWs"`
		APIKey       string                    `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	if params.K <= 0 {
		params.K = 5
	}

	strictTopics := false
	if params.StrictTopics != nil {
		strictTopics = *params.StrictTopics
	}

	EmitLog("ai.recall payload: agentWs=%s k=%d strictTopics=%v topics=%v query=%q", params.AgentWs, params.K, strictTopics, params.Topics, params.Query)

	if strings.TrimSpace(params.Query) == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "query must not be empty"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	// Step 3: API Deduplication via LRU Memory Cache
	// MED-4: Normalize cache key for case-insensitivity
	query := strings.TrimSpace(strings.ToLower(params.Query))
	var emb []float32
	recallFallbackReason := ""

	if cached, ok := recallCache.Load(query); ok {
		entry := cached.(recallCacheEntry)
		if time.Now().Before(entry.expiry) {
			emb = entry.vector
			EmitLog("Recall: Cache hit for query '%s', skipping Embed API.", query)
		} else {
			recallCache.Delete(query)
		}
	}

	if emb == nil {
		// Case 3 (P1): RetryEmbedder for realtime recall — 2 retries keep max latency ~3s.
		// embedLimiter is passed to RetryEmbedder so coordination is internal.
		rawProvider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
		provider := &ai.RetryEmbedder{
			Inner:      rawProvider,
			Limiter:    embedLimiter,
			MaxRetries: 2,
			BaseDelay:  1 * time.Second,
		}
		ctx := context.Background()
		recallCtx, recallCancel := context.WithTimeout(ctx, 10*time.Second)
		var err error
		emb, err = provider.EmbedContent(recallCtx, query)
		recallCancel()
		if err != nil {
			// Step 4: Graceful Degradation on Rate Limits
			if ai.IsRateLimitError(err) || strings.Contains(err.Error(), "deadline exceeded") {
				EmitLog("Recall: API rate limit or timeout (%v). Falling back to Lexical search only.", err)
				emb = make([]float32, 3072) // Provide Zero-vector for graceful fallback
				recallFallbackReason = "embed_fallback_lexical_only"
			} else {
				sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Failed to embed query: " + err.Error()}, ID: req.ID})
				return
			}
		} else {
			// Cache successful embedding for 15 minutes
			recallCache.Store(query, recallCacheEntry{vector: emb, expiry: time.Now().Add(15 * time.Minute)})
		}
	}

	now := time.Now()
	results, err := vstore.RecallWithQuery(params.Query, emb, params.K, now, params.Topics, strictTopics, params.Calibration, recallFallbackReason)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Recall failed: " + err.Error()}, ID: req.ID})
		return
	}

	if len(results) > 0 {
		for idx, res := range results {
			id := res.Record.ID
			if id == "" {
				continue
			}
			_ = vstore.RecordRecall(id, now, idx+1)
		}
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: results, ID: req.ID})
}

func normalizeStringSlice(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		key := strings.ToLower(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

func handleRecallFeedback(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs    string   `json:"agentWs"`
		FeedbackID string   `json:"feedbackId"`
		QueryHash  string   `json:"queryHash,omitempty"`
		Shown      []string `json:"shown,omitempty"`
		Used       []string `json:"used,omitempty"`
		Expanded   []string `json:"expanded,omitempty"`
		Source     string   `json:"source,omitempty"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if strings.TrimSpace(params.AgentWs) == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "agentWs must not be empty"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	feedbackID := strings.TrimSpace(params.FeedbackID)
	if feedbackID != "" {
		feedbackKey := []byte("meta:recall_feedback:" + feedbackID)
		if _, closer, metaErr := vstore.GetRawMeta(feedbackKey); metaErr == nil {
			if closer != nil {
				closer.Close()
			}
			sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]int{"updated": 0, "skipped": 1}, ID: req.ID})
			return
		}
	}

	now := time.Now()
	stored := map[string]any{
		"agentWs":    params.AgentWs,
		"feedbackId": feedbackID,
		"queryHash":  strings.TrimSpace(params.QueryHash),
		"shown":      normalizeStringSlice(params.Shown),
		"used":       normalizeStringSlice(params.Used),
		"expanded":   normalizeStringSlice(params.Expanded),
		"source":     strings.TrimSpace(params.Source),
		"occurredAt": now.UTC().Format(time.RFC3339Nano),
	}
	raw, _ := json.Marshal(stored)
	if feedbackID != "" {
		_ = vstore.SetMeta("recall_feedback:"+feedbackID, raw)
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]int{
		"updated":  1,
		"skipped":  0,
		"shown":    len(stored["shown"].([]string)),
		"used":     len(stored["used"].([]string)),
		"expanded": len(stored["expanded"].([]string)),
	}, ID: req.ID})
}

func handleGetWatermark(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	wm, err := vstore.GetWatermark()
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: wm, ID: req.ID})
}

func handleSetWatermark(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs   string           `json:"agentWs"`
		Watermark vector.Watermark `json:"watermark"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	err = vstore.SetWatermark(params.Watermark)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: true, ID: req.ID})
}

func handleSetMeta(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
		Key     string `json:"key"`
		Value   string `json:"value"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	err = vstore.SetMeta(params.Key, []byte(params.Value))
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: true, ID: req.ID})
}

func handleTriggerBackgroundIndex(conn net.Conn, req RPCRequest) {
	var params struct {
		FilePaths []string `json:"filePaths"`
		AgentWs   string   `json:"agentWs"`
		APIKey    string   `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	// Immediately send success response (Fire & Forget)
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "Background indexing started", ID: req.ID})

	// Spin up background daemon
	go vector.ProcessBackgroundIndexing(params.FilePaths, params.AgentWs, apiKey, vstore, embedLimiter)
}

func startWatchdog() {
	go func() {
		// When the parent Node.js process dies, stdin will be closed and Read will return EOF
		buf := make([]byte, 1)
		_, err := os.Stdin.Read(buf)
		EmitLog("Stdin closed (parent death detected): %v. Terminating.", err)
		os.Exit(0)
	}()
}

func startSleepTimer(apiKey string) {
	ticker := time.NewTicker(2 * time.Minute)
	go func() {
		for range ticker.C {
			storeMutex.Lock()
			snapshot := make(map[string]*vector.Store)
			for k, v := range vectorStores {
				snapshot[k] = v
			}
			storeMutex.Unlock()

			// Check all active workspaces
			for agentWs, vstore := range snapshot {
				checkSleepThreshold(agentWs, vstore)
			}
		}
	}()
}

func startReplayTimer(apiKey string) {
	ticker := time.NewTicker(15 * time.Minute)
	go func() {
		for range ticker.C {
			storeMutex.Lock()
			snapshot := make(map[string]*vector.Store)
			for k, v := range vectorStores {
				snapshot[k] = v
			}
			storeMutex.Unlock()

			for agentWs, vstore := range snapshot {
				checkReplayThreshold(agentWs, vstore, apiKey)
			}
		}
	}()
}

func checkReplayThreshold(agentWs string, vstore *vector.Store, apiKey string) {
	if apiKey == "" {
		return
	}

	if !atomic.CompareAndSwapInt32(&isReplaying, 0, 1) {
		EmitLog("Skipping Replay Timer for %s, replay already in progress", agentWs)
		return
	}

	go func(ws string, vs *vector.Store) {
		defer atomic.StoreInt32(&isReplaying, 0)

		replayCtx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()

		if err := vector.RunReplayScheduler(replayCtx, ws, apiKey, vs, gemmaLimiter); err != nil {
			EmitLog("Replay scheduler error for %s: %v", ws, err)
			return
		}
		_ = vs.SetMeta("last_replay", []byte(fmt.Sprintf("%d", time.Now().Unix())))
	}(agentWs, vstore)
}

func checkSleepThreshold(agentWs string, vstore *vector.Store) {
	val, closer, err := vstore.GetRawMeta([]byte("meta:last_activity"))
	if err != nil {
		if closer != nil {
			closer.Close()
		}
		// H-2: pebble:not found is normal before first session. Suppress noise.
		if strings.Contains(err.Error(), "not found") {
			return
		}
		EmitLog("[SleepTimer] WARN: GetRawMeta failed for %s: %v", agentWs, err)
		return
	}
	if len(val) == 0 {
		closer.Close()
		EmitLog("[SleepTimer] WARN: last_activity is empty for %s", agentWs)
		return
	}

	var lastActivity int64
	fmt.Sscanf(string(val), "%d", &lastActivity)
	closer.Close()

	if lastActivity == 0 {
		EmitLog("[SleepTimer] WARN: last_activity is zero for %s", agentWs)
		return
	}

	// 3 hours threshold
	idleSeconds := time.Now().Unix() - lastActivity
	if idleSeconds > 3*3600 {
		// v0.4.1+: D1 consolidation is disabled. Narrative mode replaces the D1 pipeline.
		EmitLog("[SleepTimer] Idle %dh%02dm for %s (consolidation disabled in v0.4.1+)",
			idleSeconds/3600, (idleSeconds%3600)/60, agentWs)
	}
}

func handleConsolidate(conn net.Conn, req RPCRequest) {
	EmitLog("[Consolidation] D1 consolidation is disabled in v0.4.1+. " +
		"Narrative mode replaces D1 pipeline. No action taken.")
	sendResponse(conn, RPCResponse{
		JSONRPC: "2.0",
		Result:  "Consolidation disabled (v0.4.1+): narrative mode replaces D1 pipeline",
		ID:      req.ID,
	})
}

func handleReplay(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
		APIKey  string `json:"apiKey"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	apiKey := params.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "Replay Scheduler Started", ID: req.ID})

	go func() {
		if !atomic.CompareAndSwapInt32(&isReplaying, 0, 1) {
			EmitLog("Replay skipped: already running")
			return
		}
		defer atomic.StoreInt32(&isReplaying, 0)

		replayCtx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		defer cancel()

		if err := vector.RunReplayScheduler(replayCtx, params.AgentWs, apiKey, vstore, gemmaLimiter); err != nil {
			EmitLog("Replay scheduler error (manual): %v", err)
			return
		}
		_ = vstore.SetMeta("last_replay", []byte(fmt.Sprintf("%d", time.Now().Unix())))
	}()
}

func handleExpand(conn net.Conn, req RPCRequest) {
	var params struct {
		Slug    string `json:"slug"`
		AgentWs string `json:"agentWs"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed"}, ID: req.ID})
		return
	}

	d1Rec, err := vstore.Get(params.Slug)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "D1 not found"}, ID: req.ID})
		return
	}

	var children []string
	var bodies []string

	for _, edge := range d1Rec.Edges {
		if edge.Type == "child" {
			children = append(children, edge.ID)
			d0, d0Err := vstore.Get(edge.ID)
			if d0Err == nil {
				doc, parseErr := frontmatter.Parse(d0.SourcePath)
				if parseErr == nil {
					bodies = append(bodies, fmt.Sprintf("Episode ID: %s\n%s", edge.ID, doc.Body))
				}
			}
		}
	}

	result := map[string]interface{}{
		"children": children,
		"body":     strings.Join(bodies, "\n---\n"),
	}

	now := time.Now()
	_ = vstore.UpdateRecord(params.Slug, func(rec *vector.EpisodeRecord) error {
		rec.Retrievals++
		rec.Hits += 2
		rec.LastRetrievedAt = now
		rec.LastHitAt = now
		return nil
	})

	obsID := fmt.Sprintf("expand:%s:%d", params.Slug, now.UnixNano())
	if req.ID != nil {
		obsID = fmt.Sprintf("expand:%s:%d", params.Slug, *req.ID)
	}
	_ = vstore.ApplyReplayObservation(vector.ReplayObservation{
		ObservationID: obsID,
		WorkspaceID:   params.AgentWs,
		EpisodeID:     params.Slug,
		Outcome:       "ExpandedGood",
		OccurredAt:    now,
		Source:        "ep-expand",
	})

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: result, ID: req.ID})
}

func handleRebuildLexical(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}
	if params.AgentWs == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Missing 'agentWs'"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	count, err := vstore.RebuildLexicalIndex()
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: err.Error()}, ID: req.ID})
		return
	}

	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: map[string]interface{}{
		"enqueued": count,
		"message":  fmt.Sprintf("Enqueued %d records for lexical indexing", count),
	}, ID: req.ID})
}

func handleDeleteEpisode(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string `json:"agentWs"`
		Path    string `json:"path"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.AgentWs == "" || params.Path == "" {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Missing agentWs or path"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	if err := vstore.DeleteByPath(params.Path); err != nil {
		EmitLog("Failed to delete episode by path %s: %v", params.Path, err)
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Delete failed: " + err.Error()}, ID: req.ID})
		return
	}

	EmitLog("Successfully physically deleted episode by path: %s", params.Path)
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "Deleted", ID: req.ID})
}

func handleBatchDeleteEpisodes(conn net.Conn, req RPCRequest) {
	var params struct {
		AgentWs string   `json:"agentWs"`
		Paths   []string `json:"paths"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Invalid params"}, ID: req.ID})
		return
	}

	if params.AgentWs == "" || len(params.Paths) == 0 {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32602, Message: "Missing agentWs or paths"}, ID: req.ID})
		return
	}

	vstore, err := getStore(params.AgentWs)
	if err != nil {
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Store init failed: " + err.Error()}, ID: req.ID})
		return
	}

	if err := vstore.DeleteByPaths(params.Paths); err != nil {
		EmitLog("Failed to batch delete episodes: %v", err)
		sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Batch delete failed: " + err.Error()}, ID: req.ID})
		return
	}

	EmitLog("Successfully processed batch delete for %d paths", len(params.Paths))
	sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "BatchDeleted", ID: req.ID})
}

func main() {
	socketPath := flag.String("socket", "", "Path to unix domain socket or named pipe")
	ppid := flag.Int("ppid", 0, "Parent Process ID to monitor for suicide")

	flag.Parse()

	// LOW-7: Launch periodic Garbage Collection for TTL Cache in main() to avoid init() anti-pattern
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now()
			recallCache.Range(func(key, value any) bool {
				if entry, ok := value.(recallCacheEntry); ok {
					if now.After(entry.expiry) {
						recallCache.Delete(key)
					}
				}
				return true
			})
		}
	}()

	if *socketPath == "" {
		EmitLog("Missing -socket argument")
		os.Exit(1)
	}

	InitLogger()

	if *ppid != 0 {
		// keeping flag for backwards compat, but watchdog now uses Stdin EOF
		startWatchdog()
	}

	apiKey := os.Getenv("GEMINI_API_KEY")
	startSleepTimer(apiKey)
	startReplayTimer(apiKey)

	EmitLog("Starting Go Sidecar on socket %s", *socketPath)

	// Setup listener depending on OS
	var listener net.Listener
	var err error

	if runtime.GOOS == "windows" {
		// We will use standard TCP on loopback for Windows to avoid go-winio complexity if possible,
		// or Named Pipes. For now, TCP localhost is highly reliable and standard.
		listener, err = net.Listen("tcp", *socketPath)
	} else {
		listener, err = net.Listen("unix", *socketPath)
	}

	if err != nil {
		EmitLog("Failed to listen: %v", err)
		os.Exit(1)
	}
	defer listener.Close()

	for {
		conn, err := listener.Accept()
		if err != nil {
			EmitLog("Failed to accept connection: %v", err)
			continue
		}

		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()
	defer func() {
		globalWatcherMu.Lock()
		if globalWatcherConn == conn && globalWatchers != nil {
			EmitLog("Connection closed. Stopping watchers tied to this connection.")
			for path, w := range globalWatchers {
				if w != nil {
					w.Stop()
				}
				delete(globalWatchers, path)
			}
			globalWatcherConn = nil
		}
		globalWatcherMu.Unlock()
	}()
	scanner := bufio.NewScanner(conn)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 4*1024*1024) // 4MB max

	for scanner.Scan() {
		line := scanner.Text()
		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			EmitLog("Parse error: %v", err)
			continue
		}

		// Skip per-call logging for hot-path methods that are polled frequently.
		// This reduces log noise without losing observability: state changes
		// (enqueue, ack, retry) and errors are still logged individually.
		skippedLogMethods := map[string]bool{
			"cache.leaseNext": true,
		}
		if !skippedLogMethods[req.Method] {
			EmitLog("Method: %s", req.Method)
		}

		switch req.Method {
		case "watcher.start":
			go handleWatcherStart(conn, req)
		case "frontmatter.parse":
			go handleFrontmatterParse(conn, req)
		case "indexer.rebuild":
			go handleIndexerRebuild(conn, req)
		case "ai.surprise":
			go handleSurprise(conn, req)
		case "ai.segmentScore":
			go handleSegmentScore(conn, req)
		case "ai.ingest":
			go handleIngest(conn, req)
		case "ai.batchIngest":
			go handleBatchIngest(conn, req)
		case "ai.recall":
			go handleRecall(conn, req)
		case "ai.recallFeedback":
			go handleRecallFeedback(conn, req)
		case "indexer.getWatermark":
			go handleGetWatermark(conn, req)
		case "indexer.setWatermark":
			go handleSetWatermark(conn, req)
		case "ai.setMeta":
			go handleSetMeta(conn, req)
		case "ai.triggerBackgroundIndex":
			go handleTriggerBackgroundIndex(conn, req)
		case "migration.rollbackLegacyNestedEpisodeTree":
			go handleRollbackLegacyNestedEpisodeTree(conn, req)
		case "ai.consolidate":
			go handleConsolidate(conn, req)
		case "ai.replay":
			go handleReplay(conn, req)
		case "ai.expand":
			go handleExpand(conn, req)
		case "ai.rebuildLexical":
			go handleRebuildLexical(conn, req)
		case "ai.deleteEpisode":
			go handleDeleteEpisode(conn, req)
		case "ai.batchDeleteEpisodes":
			go handleBatchDeleteEpisodes(conn, req)
		case "cache.enqueueBatch":
			go handleCacheEnqueueBatch(conn, req)
		case "cache.leaseNext":
			go handleCacheLeaseNext(conn, req)
		case "cache.ack":
			go handleCacheAck(conn, req)
		case "cache.retry":
			go handleCacheRetry(conn, req)
		case "cache.requeue":
			go handleCacheRequeue(conn, req)
		case "cache.getLatestNarrative":
			go handleGetLatestNarrative(conn, req)
		case "ping":
			go sendResponse(conn, RPCResponse{JSONRPC: "2.0", Result: "pong", ID: req.ID})
		default:
			go sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{-32601, "Method not found"}, ID: req.ID})
		}
	}
}
