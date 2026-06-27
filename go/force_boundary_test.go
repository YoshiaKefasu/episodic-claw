package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"testing"
)

func TestSanitizeControlChars(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain ASCII passthrough",
			input:    "Hello World",
			expected: "Hello World",
		},
		{
			name:     "preserves newline tab carriage-return",
			input:    "line1\nline2\ttab\rcr",
			expected: "line1\nline2\ttab\rcr",
		},
		{
			name:     "replaces control chars below 0x20",
			input:    "text\x01\x02\x03end",
			expected: "text\ufffd\ufffd\ufffdend",
		},
		{
			name:     "replaces DEL 0x7F",
			input:    "before\x7Fafter",
			expected: "before\ufffdafter",
		},
		{
			name:     "replaces C1 control chars",
			input:    "text\x80\x9Fend",
			expected: "text\ufffd\ufffdend",
		},
		{
			name:     "valid UTF-8 preserved",
			input:    "日本語テスト 🎉",
			expected: "日本語テスト 🎉",
		},
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeControlChars(tt.input)
			if got != tt.expected {
				t.Errorf("sanitizeControlChars(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestTruncateRunes(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		max      int
		expected string
	}{
		{
			name:     "short string unchanged",
			input:    "hello",
			max:      10,
			expected: "hello",
		},
		{
			name:     "exact length unchanged",
			input:    "hello",
			max:      5,
			expected: "hello",
		},
		{
			name:     "truncates to maxRunes",
			input:    "hello world",
			max:      5,
			expected: "hello",
		},
		{
			name:     "CJK chars counted as 1 rune each",
			input:    "日本語テスト",
			max:      3,
			expected: "日本語",
		},
		{
			name:     "empty string",
			input:    "",
			max:      5,
			expected: "",
		},
		{
			name:     "max 0 returns empty",
			input:    "hello",
			max:      0,
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncateRunes(tt.input, tt.max)
			if got != tt.expected {
				t.Errorf("truncateRunes(%q, %d) = %q, want %q", tt.input, tt.max, got, tt.expected)
			}
		})
	}
}

func TestValidBoundaryReasons(t *testing.T) {
	validReasons := []string{"task-complete", "topic-shift", "manual", "safety", "handoff"}
	for _, r := range validReasons {
		if !validBoundaryReasons[r] {
			t.Errorf("expected reason %q to be valid", r)
		}
	}

	invalidReasons := []string{"", "invalid-reason", "task", "complete", "TASK-COMPLETE", "unknown"}
	for _, r := range invalidReasons {
		if validBoundaryReasons[r] {
			t.Errorf("expected reason %q to be invalid", r)
		}
	}
}

func TestForceBoundaryKillSwitchEnv(t *testing.T) {
	// Test that the kill switch env var is read correctly
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", orig)
		}
	}()

	// Kill switch disabled (default)
	os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")
	if os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY") == "1" {
		t.Error("expected kill switch to be off when env var is unset")
	}

	// Kill switch enabled
	os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", "1")
	if os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY") != "1" {
		t.Error("expected kill switch to be on when env var is '1'")
	}
}

func TestForceBoundaryParamsJSON(t *testing.T) {
	// Test that params can be correctly unmarshalled
	paramsJSON := `{
		"agentWs": "/path/to/workspace",
		"agentId": "main",
		"note": "Task completed: auth module refactored",
		"reason": "task-complete",
		"titleHint": "Auth Module Refactor"
	}`

	var params struct {
		AgentWs   string `json:"agentWs"`
		AgentId   string `json:"agentId"`
		Note      string `json:"note"`
		Reason    string `json:"reason"`
		TitleHint string `json:"titleHint"`
	}

	if err := json.Unmarshal([]byte(paramsJSON), &params); err != nil {
		t.Fatalf("failed to unmarshal params: %v", err)
	}

	if params.AgentWs != "/path/to/workspace" {
		t.Errorf("AgentWs = %q, want %q", params.AgentWs, "/path/to/workspace")
	}
	if params.AgentId != "main" {
		t.Errorf("AgentId = %q, want %q", params.AgentId, "main")
	}
	if params.Note != "Task completed: auth module refactored" {
		t.Errorf("Note = %q, want %q", params.Note, "Task completed: auth module refactored")
	}
	if params.Reason != "task-complete" {
		t.Errorf("Reason = %q, want %q", params.Reason, "task-complete")
	}
	if params.TitleHint != "Auth Module Refactor" {
		t.Errorf("TitleHint = %q, want %q", params.TitleHint, "Auth Module Refactor")
	}
}

func TestForceBoundaryResponseJSON(t *testing.T) {
	// Test that response fields are correctly shaped
	response := map[string]any{
		"flushed":        false,
		"enqueuedChunks": 0,
		"fallbackReason": "ts-fallback",
		"elapsedMs":      int64(0),
	}

	data, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("failed to marshal response: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if parsed["flushed"] != false {
		t.Errorf("flushed = %v, want false", parsed["flushed"])
	}
	if parsed["fallbackReason"] != "ts-fallback" {
		t.Errorf("fallbackReason = %v, want 'ts-fallback'", parsed["fallbackReason"])
	}
}

func TestForceBoundaryNoteAndTitleHintCapping(t *testing.T) {
	// Simulate the capping logic used in the handler
	longNote := ""
	for i := 0; i < 3000; i++ {
		longNote += "x"
	}
	capped := truncateRunes(longNote, 2000)
	if len([]rune(capped)) != 2000 {
		t.Errorf("capped note length = %d, want 2000", len([]rune(capped)))
	}

	longTitle := ""
	for i := 0; i < 200; i++ {
		longTitle += "y"
	}
	cappedTitle := truncateRunes(longTitle, 120)
	if len([]rune(cappedTitle)) != 120 {
		t.Errorf("capped titleHint length = %d, want 120", len([]rune(cappedTitle)))
	}
}

// TestHandleNarrativeForceBoundary_HappyPath exercises the full handler via
// net.Pipe, verifying request→response round-trip and Phase 3 contract
// (flushed=false, fallbackReason="ts-fallback").
func TestHandleNarrativeForceBoundary_HappyPath(t *testing.T) {
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", orig)
		}
	}()
	os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")

	server, client := net.Pipe()
	defer client.Close()

	paramsJSON := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "test-agent",
		"note": "Refactored the auth module",
		"reason": "task-complete",
		"titleHint": "Auth Refactor"
	}`
	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.forceBoundary",
		Params:  json.RawMessage(paramsJSON),
		ID:      intPtr(42),
	}

	// Run handler on server side of pipe
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeForceBoundary(server, req)
		server.Close()
	}()

	// Read response from client side
	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received from handler")
	}

	var resp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v\nraw: %s", err, scanner.Text())
	}
	<-done

	// Phase 3 contract assertions
	if resp.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", resp.Error.Code, resp.Error.Message)
	}
	if resp.ID == nil || *resp.ID != 42 {
		t.Errorf("response ID = %v, want 42", resp.ID)
	}

	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is not a map: %T", resp.Result)
	}
	if result["flushed"] != false {
		t.Errorf("flushed = %v, want false", result["flushed"])
	}
	if result["fallbackReason"] != "ts-fallback" {
		t.Errorf("fallbackReason = %v, want 'ts-fallback'", result["fallbackReason"])
	}
	if result["enqueuedChunks"] != float64(0) {
		t.Errorf("enqueuedChunks = %v, want 0", result["enqueuedChunks"])
	}
	elapsedMs, ok := result["elapsedMs"].(float64)
	if !ok {
		t.Errorf("elapsedMs missing or not numeric: %v", result["elapsedMs"])
	} else if elapsedMs < 0 {
		t.Errorf("elapsedMs = %v, want >= 0", elapsedMs)
	}
}

// TestHandleNarrativeForceBoundary_KillSwitch verifies that when the kill switch
// env var is set, the handler returns fallbackReason="disabled" without writing
// to the state store.
func TestHandleNarrativeForceBoundary_KillSwitch(t *testing.T) {
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", orig)
		}
	}()
	os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", "1")

	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.forceBoundary",
		Params:  json.RawMessage(`{"agentWs":"/tmp/ws","agentId":"a"}`),
		ID:      intPtr(7),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeForceBoundary(server, req)
		server.Close()
	}()

	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received")
	}

	var resp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	<-done

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error.Message)
	}
	result := resp.Result.(map[string]any)
	if result["fallbackReason"] != "disabled" {
		t.Errorf("fallbackReason = %v, want 'disabled'", result["fallbackReason"])
	}
	if result["flushed"] != false {
		t.Errorf("flushed = %v, want false", result["flushed"])
	}
}

// TestHandleNarrativeForceBoundary_MissingAgentWs verifies param validation
// returns a -32602 error when agentWs is empty.
func TestHandleNarrativeForceBoundary_MissingAgentWs(t *testing.T) {
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY", orig)
		}
	}()
	os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY")

	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.forceBoundary",
		Params:  json.RawMessage(`{"agentWs":"","agentId":"a"}`),
		ID:      intPtr(9),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeForceBoundary(server, req)
		server.Close()
	}()

	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received")
	}

	var resp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	<-done

	if resp.Error == nil {
		t.Fatal("expected error for missing agentWs, got nil")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code = %d, want -32602", resp.Error.Code)
	}
}

func intPtr(i int) *int { return &i }
