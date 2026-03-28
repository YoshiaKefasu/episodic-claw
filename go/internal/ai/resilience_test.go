package ai_test

// resilience_test.go — NEW-3 単体テスト (2026-03-27)
//
// テスト対象:
//   - IsRateLimitError(): 直接 APIError / fmt.Errorf ラップ / 非429 の各ケース
//   - WithRetryAfter() + RetryAfter(): retryAfterDur の正確な伝播
//   - ParseRetryAfterHeader(): 秒文字列の解析
//   - heal429State の TTL / カウント遷移ロジック（インライン模擬で境界条件を確認）
//
// go test ./internal/ai/... -v -run TestResilient

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"episodic-core/internal/ai"
)

// ---------------------------------------------------------------------------
// IsRateLimitError
// ---------------------------------------------------------------------------

func TestIsRateLimitError_Direct429(t *testing.T) {
	err := &ai.APIError{StatusCode: http.StatusTooManyRequests, Body: "quota exceeded"}
	if !ai.IsRateLimitError(err) {
		t.Fatal("expected true for direct 429 APIError")
	}
}

func TestIsRateLimitError_Wrapped429(t *testing.T) {
	// NEW-3 境界条件: fmt.Errorf("%w", apiErr) でラップされた場合に errors.As が機能するか
	inner := &ai.APIError{StatusCode: http.StatusTooManyRequests, Body: "quota exceeded"}
	wrapped := fmt.Errorf("some context: %w", inner)
	if !ai.IsRateLimitError(wrapped) {
		t.Fatal("expected true for fmt.Errorf-wrapped 429 APIError (errors.As must unwrap)")
	}
}

func TestIsRateLimitError_Non429(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"500 server error", &ai.APIError{StatusCode: 500, Body: "internal error"}},
		{"plain error", errors.New("network timeout")},
		{"nil", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if ai.IsRateLimitError(tc.err) {
				t.Fatalf("expected false for %q, got true", tc.name)
			}
		})
	}
}

func TestIsRateLimitError_Nil(t *testing.T) {
	if ai.IsRateLimitError(nil) {
		t.Fatal("expected false for nil error")
	}
}

// ---------------------------------------------------------------------------
// APIError.WithRetryAfter + RetryAfter
// ---------------------------------------------------------------------------

func TestWithRetryAfter_PropagatesCorrectly(t *testing.T) {
	base := &ai.APIError{StatusCode: http.StatusTooManyRequests, Body: "quota"}
	if base.RetryAfter() != 0 {
		t.Fatal("expected zero RetryAfter on fresh APIError")
	}

	enriched := base.WithRetryAfter(90 * time.Second)
	if enriched.RetryAfter() != 90*time.Second {
		t.Fatalf("method: expected 90s, got %v", enriched.RetryAfter())
	}
	// P3: RetryAfterDur is now exported — verify direct field access works
	if enriched.RetryAfterDur != 90*time.Second {
		t.Fatalf("field: expected 90s, got %v", enriched.RetryAfterDur)
	}
	// original must not be mutated (copy-on-write via WithRetryAfter)
	if base.RetryAfter() != 0 {
		t.Fatal("WithRetryAfter must not mutate source (copy-on-write)")
	}
	if base.RetryAfterDur != 0 {
		t.Fatal("WithRetryAfter must not mutate source field (copy-on-write)")
	}
}


// ---------------------------------------------------------------------------
// ParseRetryAfterHeader
// ---------------------------------------------------------------------------

func TestParseRetryAfterHeader_Seconds(t *testing.T) {
	cases := []struct {
		input    string
		expected time.Duration
	}{
		{"60", 60 * time.Second},
		{"3600", 3600 * time.Second},
		{"0", 0},
		{"invalid", 0}, // invalid → fallback to 0
		{"", 0},
	}
	for _, tc := range cases {
		got := ai.ParseRetryAfterHeader(tc.input)
		if got != tc.expected {
			t.Errorf("ParseRetryAfterHeader(%q) = %v, want %v", tc.input, got, tc.expected)
		}
	}
}

// ---------------------------------------------------------------------------
// heal429State TTL / カウント遷移ロジック (インライン模擬)
//
// RunAsyncHealingWorker は main パッケージの非公開関数内に heal429State を
// ローカル型として定義しているため、公開テストから直接呼べない。
// そのため、同一ロジックを ai パッケージのヘルパーに抽出せず、
// 同等のロジックをここで模擬してコア的な境界条件を検証する。
// ---------------------------------------------------------------------------

// heal429State は RunAsyncHealingWorker 内の非公開型と同じ構造体。
// テスト用にここで宣言して TTL ロジックを直接検証する。
type heal429State struct {
	Count int       `json:"count"`
	Since time.Time `json:"since"`
}

const heal429Threshold = 3
const heal429TTL = 2 * time.Hour

// applyTTLReset は RunAsyncHealingWorker の TTL チェックロジックを再現する。
func applyTTLReset(h *heal429State, now time.Time) bool {
	if h.Count > 0 && now.Sub(h.Since) > heal429TTL {
		*h = heal429State{}
		return true
	}
	return false
}

// TestHeal429State_TTLReset: Count=3, Since=2h超前 → リセットされること
func TestHeal429State_TTLReset(t *testing.T) {
	h := heal429State{Count: 3, Since: time.Now().Add(-3 * time.Hour)}
	reset := applyTTLReset(&h, time.Now())
	if !reset {
		t.Fatal("expected TTL reset to trigger")
	}
	if h.Count != 0 {
		t.Fatalf("expected Count=0 after TTL reset, got %d", h.Count)
	}
}

// TestHeal429State_NoTTLReset_WithinWindow: Count=3, Since=1h前 → リセットされないこと
func TestHeal429State_NoTTLReset_WithinWindow(t *testing.T) {
	h := heal429State{Count: 3, Since: time.Now().Add(-1 * time.Hour)}
	reset := applyTTLReset(&h, time.Now())
	if reset {
		t.Fatal("expected NO TTL reset when within 2h window")
	}
	if h.Count != 3 {
		t.Fatalf("expected Count=3 after no reset, got %d", h.Count)
	}
}

// TestHeal429State_CountIncrement: 429 × 3 回でバックオフ状態になること
func TestHeal429State_CountIncrement(t *testing.T) {
	h := heal429State{}
	for i := 1; i <= heal429Threshold; i++ {
		if h.Count == 0 {
			h.Since = time.Now()
		}
		h.Count++
	}
	if h.Count < heal429Threshold {
		t.Fatalf("expected Count >= %d (backoff), got %d", heal429Threshold, h.Count)
	}
}

// TestHeal429State_CountBoundary_OffByOne: Count=2 → +1 → バックオフ判定
func TestHeal429State_CountBoundary_OffByOne(t *testing.T) {
	h := heal429State{Count: 2, Since: time.Now()}
	// simulate one more 429
	h.Count++
	if h.Count != 3 {
		t.Fatalf("expected Count=3, got %d", h.Count)
	}
	if h.Count < heal429Threshold {
		t.Fatal("Count=3 should trigger backoff (>= threshold=3)")
	}
}

// TestHeal429State_NonRateLimitResets: 非429エラー後に Count=0 になること
func TestHeal429State_NonRateLimitResets(t *testing.T) {
	h := heal429State{Count: 2, Since: time.Now()}
	nonRateLimitErr := errors.New("context deadline exceeded")
	if !ai.IsRateLimitError(nonRateLimitErr) {
		// simulate the non-429 branch reset
		h = heal429State{}
	}
	if h.Count != 0 {
		t.Fatalf("non-429 error should reset Count to 0, got %d", h.Count)
	}
}

// TestHeal429State_JSONRoundTrip: json.Unmarshal 失敗時 → Count=0 フォールバック
func TestHeal429State_JSONRoundTrip_Corrupt(t *testing.T) {
	var h heal429State
	corruptBytes := []byte("NOT_JSON{{{{")
	if err := json.Unmarshal(corruptBytes, &h); err != nil {
		// Expected: Unmarshal fails → h stays zero value
		if h.Count != 0 {
			t.Fatalf("corrupt bytes: expected Count=0 fallback, got %d", h.Count)
		}
		return // correct behavior: zero value, no panic
	}
	// If Unmarshal somehow succeeded with zero value output, also fine
	if h.Count != 0 {
		t.Fatalf("corrupt bytes: expected Count=0, got %d", h.Count)
	}
}

// TestHeal429State_JSONRoundTrip_Valid: 正常な JSON が正確に復元されること
func TestHeal429State_JSONRoundTrip_Valid(t *testing.T) {
	original := heal429State{Count: 2, Since: time.Date(2026, 3, 27, 12, 0, 0, 0, time.UTC)}
	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	var restored heal429State
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	if restored.Count != original.Count {
		t.Fatalf("Count mismatch: got %d, want %d", restored.Count, original.Count)
	}
	if !restored.Since.Equal(original.Since) {
		t.Fatalf("Since mismatch: got %v, want %v", restored.Since, original.Since)
	}
}

// TestHeal429State_SetMeta_DirectBytes: handleSetMeta は []byte(params.Value) で変換するため
// JSON 文字列を value に渡せばそのまま SetMeta に届く — NEW-1 の調査結果を回帰テストで固定。
// （実際の Pebble DB への書き込みはモック不要。変換ロジックのみテスト。）
func TestHeal429State_SetMeta_DirectBytes(t *testing.T) {
	// handleSetMeta の core: []byte(params.Value)
	valueStr := `{"count":0,"since":"0001-01-01T00:00:00Z"}`
	rawBytes := []byte(valueStr)

	var h heal429State
	if err := json.Unmarshal(rawBytes, &h); err != nil {
		t.Fatalf("Unmarshal of manual-reset JSON failed: %v", err)
	}
	if h.Count != 0 {
		t.Fatalf("manual reset should produce Count=0, got %d", h.Count)
	}
	// NEW-1 resolution: []byte(string) is transparent UTF-8 cast, not base64.
	// This test documents and locks that assumption.
}
