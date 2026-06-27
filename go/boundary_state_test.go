package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"testing"
)

func TestBoundaryStateGet_EmptyDefault(t *testing.T) {
	// Test that getting boundary state for a non-existent agent returns empty/default
	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/test-ws-empty-default","agentId":"test-agent-empty-default"}`),
		ID:      intPtr(1),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateGet(server, req)
		server.Close()
	}()

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

	if resp.Error != nil {
		t.Fatalf("unexpected error: code=%d msg=%s", resp.Error.Code, resp.Error.Message)
	}

	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is not a map: %T", resp.Result)
	}

	if result["exists"] != false {
		t.Errorf("exists = %v, want false", result["exists"])
	}
}

func TestBoundaryStateSet_GetRoundTrip(t *testing.T) {
	// Test that setting and then getting boundary state works correctly
	server, client := net.Pipe()
	defer client.Close()

	// First, set the boundary state
	setParams := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "test-agent",
		"state": {
			"latestCheckpoint": {
				"index": 42,
				"rawSurprise": 0.15,
				"isFullBoundary": true,
				"createdAt": "2026-06-27T12:00:00.000Z"
			},
			"lastBoundaryReason": "surprise-boundary",
			"lastBoundaryAt": "2026-06-27T12:00:00.000Z",
			"boundarySequence": 5
		}
	}`

	setReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(setParams),
		ID:      intPtr(2),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateSet(server, setReq)
		server.Close()
	}()

	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received from set handler")
	}

	var setResp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &setResp); err != nil {
		t.Fatalf("failed to unmarshal set response: %v", err)
	}
	<-done

	if setResp.Error != nil {
		t.Fatalf("set failed: %v", setResp.Error.Message)
	}

	setResult, ok := setResp.Result.(map[string]any)
	if !ok {
		t.Fatalf("set result is not a map: %T", setResp.Result)
	}
	if setResult["persisted"] != true {
		t.Errorf("persisted = %v, want true", setResult["persisted"])
	}

	// Now get the boundary state
	server2, client2 := net.Pipe()
	defer client2.Close()

	getReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/test-ws","agentId":"test-agent"}`),
		ID:      intPtr(3),
	}

	done2 := make(chan struct{})
	go func() {
		defer close(done2)
		handleNarrativeBoundaryStateGet(server2, getReq)
		server2.Close()
	}()

	scanner2 := bufio.NewScanner(client2)
	scanner2.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner2.Scan() {
		t.Fatal("no response received from get handler")
	}

	var getResp RPCResponse
	if err := json.Unmarshal(scanner2.Bytes(), &getResp); err != nil {
		t.Fatalf("failed to unmarshal get response: %v", err)
	}
	<-done2

	if getResp.Error != nil {
		t.Fatalf("get failed: %v", getResp.Error.Message)
	}

	getResult, ok := getResp.Result.(map[string]any)
	if !ok {
		t.Fatalf("get result is not a map: %T", getResp.Result)
	}

	if getResult["exists"] != true {
		t.Errorf("exists = %v, want true", getResult["exists"])
	}

	state, ok := getResult["state"].(map[string]any)
	if !ok {
		t.Fatalf("state is not a map: %T", getResult["state"])
	}

	if state["lastBoundaryReason"] != "surprise-boundary" {
		t.Errorf("lastBoundaryReason = %v, want 'surprise-boundary'", state["lastBoundaryReason"])
	}

	if state["lastBoundaryAt"] != "2026-06-27T12:00:00.000Z" {
		t.Errorf("lastBoundaryAt = %v, want '2026-06-27T12:00:00.000Z'", state["lastBoundaryAt"])
	}

	if state["boundarySequence"] != float64(5) {
		t.Errorf("boundarySequence = %v, want 5", state["boundarySequence"])
	}

	checkpoint, ok := state["latestCheckpoint"].(map[string]any)
	if !ok {
		t.Fatalf("latestCheckpoint is not a map: %T", state["latestCheckpoint"])
	}

	if checkpoint["index"] != float64(42) {
		t.Errorf("checkpoint.index = %v, want 42", checkpoint["index"])
	}

	if checkpoint["rawSurprise"] != 0.15 {
		t.Errorf("checkpoint.rawSurprise = %v, want 0.15", checkpoint["rawSurprise"])
	}

	if checkpoint["isFullBoundary"] != true {
		t.Errorf("checkpoint.isFullBoundary = %v, want true", checkpoint["isFullBoundary"])
	}
}

func TestBoundaryStateSet_Overwrite(t *testing.T) {
	// Test that setting boundary state overwrites the previous state
	server, client := net.Pipe()
	defer client.Close()

	// Set initial state
	setParams1 := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "overwrite-agent",
		"state": {
			"latestCheckpoint": {
				"index": 10,
				"rawSurprise": 0.1,
				"isFullBoundary": false,
				"createdAt": "2026-06-27T11:00:00.000Z"
			},
			"lastBoundaryReason": "time-gap",
			"boundarySequence": 1
		}
	}`

	setReq1 := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(setParams1),
		ID:      intPtr(4),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateSet(server, setReq1)
		server.Close()
	}()

	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received from first set handler")
	}

	var setResp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &setResp); err != nil {
		t.Fatalf("failed to unmarshal first set response: %v", err)
	}
	<-done

	if setResp.Error != nil {
		t.Fatalf("first set failed: %v", setResp.Error.Message)
	}

	// Overwrite with new state
	server2, client2 := net.Pipe()
	defer client2.Close()

	setParams2 := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "overwrite-agent",
		"state": {
			"latestCheckpoint": {
				"index": 20,
				"rawSurprise": 0.2,
				"isFullBoundary": true,
				"createdAt": "2026-06-27T12:00:00.000Z"
			},
			"lastBoundaryReason": "surprise-boundary",
			"boundarySequence": 2
		}
	}`

	setReq2 := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(setParams2),
		ID:      intPtr(5),
	}

	done2 := make(chan struct{})
	go func() {
		defer close(done2)
		handleNarrativeBoundaryStateSet(server2, setReq2)
		server2.Close()
	}()

	scanner2 := bufio.NewScanner(client2)
	scanner2.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner2.Scan() {
		t.Fatal("no response received from second set handler")
	}

	var setResp2 RPCResponse
	if err := json.Unmarshal(scanner2.Bytes(), &setResp2); err != nil {
		t.Fatalf("failed to unmarshal second set response: %v", err)
	}
	<-done2

	if setResp2.Error != nil {
		t.Fatalf("second set failed: %v", setResp2.Error.Message)
	}

	// Verify the overwrite worked
	server3, client3 := net.Pipe()
	defer client3.Close()

	getReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/test-ws","agentId":"overwrite-agent"}`),
		ID:      intPtr(6),
	}

	done3 := make(chan struct{})
	go func() {
		defer close(done3)
		handleNarrativeBoundaryStateGet(server3, getReq)
		server3.Close()
	}()

	scanner3 := bufio.NewScanner(client3)
	scanner3.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner3.Scan() {
		t.Fatal("no response received from get handler")
	}

	var getResp RPCResponse
	if err := json.Unmarshal(scanner3.Bytes(), &getResp); err != nil {
		t.Fatalf("failed to unmarshal get response: %v", err)
	}
	<-done3

	if getResp.Error != nil {
		t.Fatalf("get failed: %v", getResp.Error.Message)
	}

	getResult := getResp.Result.(map[string]any)
	state := getResult["state"].(map[string]any)

	if state["lastBoundaryReason"] != "surprise-boundary" {
		t.Errorf("lastBoundaryReason = %v, want 'surprise-boundary'", state["lastBoundaryReason"])
	}

	if state["boundarySequence"] != float64(2) {
		t.Errorf("boundarySequence = %v, want 2", state["boundarySequence"])
	}

	checkpoint := state["latestCheckpoint"].(map[string]any)
	if checkpoint["index"] != float64(20) {
		t.Errorf("checkpoint.index = %v, want 20", checkpoint["index"])
	}
}

func TestBoundaryStateSet_StaleSequenceIgnored(t *testing.T) {
	setReq := func(id int, stateJSON string) RPCRequest {
		return RPCRequest{
			JSONRPC: "2.0",
			Method:  "narrative.boundaryStateSet",
			Params:  json.RawMessage(stateJSON),
			ID:      intPtr(id),
		}
	}
	runSet := func(t *testing.T, req RPCRequest) map[string]any {
		t.Helper()
		server, client := net.Pipe()
		defer client.Close()
		done := make(chan struct{})
		go func() {
			defer close(done)
			handleNarrativeBoundaryStateSet(server, req)
			server.Close()
		}()
		scanner := bufio.NewScanner(client)
		scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
		if !scanner.Scan() {
			t.Fatal("no response received from set handler")
		}
		var resp RPCResponse
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal set response: %v", err)
		}
		<-done
		if resp.Error != nil {
			t.Fatalf("set failed: %v", resp.Error.Message)
		}
		result, ok := resp.Result.(map[string]any)
		if !ok {
			t.Fatalf("set result is not a map: %T", resp.Result)
		}
		return result
	}
	runGet := func(t *testing.T, agentWs string, agentId string) map[string]any {
		t.Helper()
		server, client := net.Pipe()
		defer client.Close()
		req := RPCRequest{
			JSONRPC: "2.0",
			Method:  "narrative.boundaryStateGet",
			Params:  json.RawMessage(`{"agentWs":"` + agentWs + `","agentId":"` + agentId + `"}`),
			ID:      intPtr(999),
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			handleNarrativeBoundaryStateGet(server, req)
			server.Close()
		}()
		scanner := bufio.NewScanner(client)
		scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
		if !scanner.Scan() {
			t.Fatal("no response received from get handler")
		}
		var resp RPCResponse
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal get response: %v", err)
		}
		<-done
		if resp.Error != nil {
			t.Fatalf("get failed: %v", resp.Error.Message)
		}
		result, ok := resp.Result.(map[string]any)
		if !ok {
			t.Fatalf("get result is not a map: %T", resp.Result)
		}
		return result
	}

	agentWs := "/tmp/test-ws-stale"
	agentId := "stale-agent"

	newer := runSet(t, setReq(100, `{
		"agentWs":"/tmp/test-ws-stale",
		"agentId":"stale-agent",
		"state":{
			"latestCheckpoint":{"index":30,"rawSurprise":0.3,"isFullBoundary":true,"createdAt":"2026-06-27T12:30:00.000Z"},
			"lastBoundaryReason":"surprise-boundary",
			"boundarySequence":3
		}
	}`))
	if newer["persisted"] != true {
		t.Fatalf("newer persisted = %v, want true", newer["persisted"])
	}

	stale := runSet(t, setReq(101, `{
		"agentWs":"/tmp/test-ws-stale",
		"agentId":"stale-agent",
		"state":{
			"latestCheckpoint":{"index":10,"rawSurprise":0.1,"isFullBoundary":false,"createdAt":"2026-06-27T11:00:00.000Z"},
			"lastBoundaryReason":"checkpoint",
			"boundarySequence":2
		}
	}`))
	if stale["persisted"] != false {
		t.Fatalf("stale persisted = %v, want false", stale["persisted"])
	}
	if stale["stale"] != true {
		t.Fatalf("stale marker = %v, want true", stale["stale"])
	}

	getResult := runGet(t, agentWs, agentId)
	state := getResult["state"].(map[string]any)
	if state["boundarySequence"] != float64(3) {
		t.Fatalf("boundarySequence = %v, want 3", state["boundarySequence"])
	}
	checkpoint := state["latestCheckpoint"].(map[string]any)
	if checkpoint["index"] != float64(30) {
		t.Fatalf("checkpoint.index = %v, want 30", checkpoint["index"])
	}
}

func TestBoundaryStateGet_KillSwitch(t *testing.T) {
	// Test that kill switch makes get return empty state
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE", orig)
		}
	}()
	os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE", "1")

	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/ws","agentId":"a"}`),
		ID:      intPtr(7),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateGet(server, req)
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
	if result["exists"] != false {
		t.Errorf("exists = %v, want false (kill switch active)", result["exists"])
	}
}

func TestBoundaryStateSet_KillSwitch(t *testing.T) {
	// Test that kill switch makes set return persisted=false
	orig := os.Getenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE")
	defer func() {
		if orig == "" {
			os.Unsetenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE")
		} else {
			os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE", orig)
		}
	}()
	os.Setenv("EPISODIC_DISABLE_GO_BOUNDARY_STATE", "1")

	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/ws","agentId":"a","state":{}}`),
		ID:      intPtr(8),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateSet(server, req)
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
	if result["persisted"] != false {
		t.Errorf("persisted = %v, want false (kill switch active)", result["persisted"])
	}
}

func TestBoundaryStateGet_MissingAgentWs(t *testing.T) {
	// Test that missing agentWs returns error
	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"","agentId":"a"}`),
		ID:      intPtr(9),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateGet(server, req)
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

func TestBoundaryStateSet_MissingAgentId(t *testing.T) {
	// Test that missing agentId returns error
	server, client := net.Pipe()
	defer client.Close()

	req := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/ws","agentId":"","state":{}}`),
		ID:      intPtr(10),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateSet(server, req)
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
		t.Fatal("expected error for missing agentId, got nil")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code = %d, want -32602", resp.Error.Code)
	}
}

func TestBoundaryStateJSON_RoundTrip(t *testing.T) {
	// Test that BoundaryState can be correctly marshalled/unmarshalled
	state := BoundaryState{
		LatestCheckpoint: &SurpriseCheckpointSummary{
			Index:          42,
			RawSurprise:    0.15,
			IsFullBoundary: true,
			CreatedAt:      "2026-06-27T12:00:00.000Z",
		},
		LastBoundaryReason: "surprise-boundary",
		LastBoundaryAt:     "2026-06-27T12:00:00.000Z",
		BoundarySequence:   5,
	}

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed BoundaryState
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if parsed.LatestCheckpoint == nil {
		t.Fatal("LatestCheckpoint is nil after round-trip")
	}

	if parsed.LatestCheckpoint.Index != 42 {
		t.Errorf("Index = %d, want 42", parsed.LatestCheckpoint.Index)
	}

	if parsed.LatestCheckpoint.RawSurprise != 0.15 {
		t.Errorf("RawSurprise = %f, want 0.15", parsed.LatestCheckpoint.RawSurprise)
	}

	if !parsed.LatestCheckpoint.IsFullBoundary {
		t.Error("IsFullBoundary = false, want true")
	}

	if parsed.LastBoundaryReason != "surprise-boundary" {
		t.Errorf("LastBoundaryReason = %q, want 'surprise-boundary'", parsed.LastBoundaryReason)
	}

	if parsed.BoundarySequence != 5 {
		t.Errorf("BoundarySequence = %d, want 5", parsed.BoundarySequence)
	}
}

func TestBoundaryStateJSON_EmptyOmitempty(t *testing.T) {
	// Test that empty state marshals correctly with omitempty
	state := BoundaryState{}

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	// Empty state should produce minimal JSON
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	// omitempty fields should not be present
	if _, exists := parsed["latestCheckpoint"]; exists {
		t.Error("latestCheckpoint should be omitted when nil")
	}
	if _, exists := parsed["lastBoundaryReason"]; exists {
		t.Error("lastBoundaryReason should be omitted when empty")
	}
	if _, exists := parsed["lastBoundaryAt"]; exists {
		t.Error("lastBoundaryAt should be omitted when empty")
	}
	// boundarySequence should be 0 (default), which is omitted by omitempty
	if _, exists := parsed["boundarySequence"]; exists {
		t.Error("boundarySequence should be omitted when 0")
	}
}

func TestBoundaryStateClear(t *testing.T) {
	// Test that setting empty state effectively clears the persisted state
	// (This is how TS segmenter will clear checkpoints)

	// First, set some state
	server, client := net.Pipe()
	defer client.Close()

	setParams := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "clear-agent",
		"state": {
			"latestCheckpoint": {
				"index": 10,
				"rawSurprise": 0.1,
				"isFullBoundary": false,
				"createdAt": "2026-06-27T11:00:00.000Z"
			},
			"lastBoundaryReason": "time-gap",
			"boundarySequence": 1
		}
	}`

	setReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(setParams),
		ID:      intPtr(11),
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		handleNarrativeBoundaryStateSet(server, setReq)
		server.Close()
	}()

	scanner := bufio.NewScanner(client)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner.Scan() {
		t.Fatal("no response received from set handler")
	}

	var setResp RPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &setResp); err != nil {
		t.Fatalf("failed to unmarshal set response: %v", err)
	}
	<-done

	// Now clear by setting empty state
	server2, client2 := net.Pipe()
	defer client2.Close()

	clearParams := `{
		"agentWs": "/tmp/test-ws",
		"agentId": "clear-agent",
		"state": {}
	}`

	clearReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateSet",
		Params:  json.RawMessage(clearParams),
		ID:      intPtr(12),
	}

	done2 := make(chan struct{})
	go func() {
		defer close(done2)
		handleNarrativeBoundaryStateSet(server2, clearReq)
		server2.Close()
	}()

	scanner2 := bufio.NewScanner(client2)
	scanner2.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner2.Scan() {
		t.Fatal("no response received from clear handler")
	}

	var clearResp RPCResponse
	if err := json.Unmarshal(scanner2.Bytes(), &clearResp); err != nil {
		t.Fatalf("failed to unmarshal clear response: %v", err)
	}
	<-done2

	// Verify the state is now empty
	server3, client3 := net.Pipe()
	defer client3.Close()

	getReq := RPCRequest{
		JSONRPC: "2.0",
		Method:  "narrative.boundaryStateGet",
		Params:  json.RawMessage(`{"agentWs":"/tmp/test-ws","agentId":"clear-agent"}`),
		ID:      intPtr(13),
	}

	done3 := make(chan struct{})
	go func() {
		defer close(done3)
		handleNarrativeBoundaryStateGet(server3, getReq)
		server3.Close()
	}()

	scanner3 := bufio.NewScanner(client3)
	scanner3.Buffer(make([]byte, 0, 64*1024), 64*1024)
	if !scanner3.Scan() {
		t.Fatal("no response received from get handler")
	}

	var getResp RPCResponse
	if err := json.Unmarshal(scanner3.Bytes(), &getResp); err != nil {
		t.Fatalf("failed to unmarshal get response: %v", err)
	}
	<-done3

	if getResp.Error != nil {
		t.Fatalf("get failed: %v", getResp.Error.Message)
	}

	getResult := getResp.Result.(map[string]any)
	// After clearing, state should still exist (empty) but have no checkpoint
	state := getResult["state"].(map[string]any)
	if _, exists := state["latestCheckpoint"]; exists {
		t.Error("latestCheckpoint should be cleared after setting empty state")
	}
	if v := state["lastBoundaryReason"]; v != nil && v != "" {
		t.Errorf("lastBoundaryReason should be empty after clear, got %v", v)
	}
}
