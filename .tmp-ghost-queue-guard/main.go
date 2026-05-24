package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cockroachdb/pebble"
)

type queueItem struct {
	ID              string `json:"id"`
	AgentWs         string `json:"agentWs"`
	AgentID         string `json:"agentId"`
	Source          string `json:"source"`
	ParentIngestID  string `json:"parentIngestId"`
	OrderKey        string `json:"orderKey"`
	Reason          string `json:"reason"`
	EstimatedTokens int    `json:"estimatedTokens"`
	Status          string `json:"status"`
	Attempts        int    `json:"attempts"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	LeaseOwner      string `json:"leaseOwner,omitempty"`
	LeaseUntil      string `json:"leaseUntil,omitempty"`
	BackoffUntil    string `json:"backoffUntil,omitempty"`
	LastError       string `json:"lastError,omitempty"`
}

type report struct {
	Key       string    `json:"key"`
	ID        string    `json:"id"`
	Found     bool      `json:"found"`
	Status    string    `json:"status,omitempty"`
	Action    string    `json:"action"`
	Item      queueItem `json:"item,omitempty"`
	LiveState bool      `json:"liveState"`
}

var targets = map[string]bool{
	"main:2026-05-01T06-30-35-008Z-0001": true,
	"main:2026-05-01T06-30-35-023Z-0002": true,
	"main:2026-05-01T06-30-35-028Z-0003": true,
}

func main() {
	dbPath := flag.String("db", "", "Path to cache.db")
	mode := flag.String("mode", "inspect", "inspect or deadletter")
	flag.Parse()

	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "missing -db")
		os.Exit(2)
	}
	if *mode != "inspect" && *mode != "deadletter" {
		fmt.Fprintln(os.Stderr, "invalid -mode")
		os.Exit(2)
	}

	opts := &pebble.Options{}
	if *mode == "inspect" {
		opts.ReadOnly = true
	}
	db, err := pebble.Open(*dbPath, opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open cache db: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	seen := map[string]bool{}
	changed := 0

	iter, err := db.NewIter(&pebble.IterOptions{LowerBound: []byte("main:"), UpperBound: []byte("main;")})
	if err != nil {
		fmt.Fprintf(os.Stderr, "create iterator: %v\n", err)
		os.Exit(1)
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var item queueItem
		if err := json.Unmarshal(iter.Value(), &item); err != nil {
			continue
		}
		if !targets[item.ID] {
			continue
		}

		seen[item.ID] = true
		action := "inspect-only"
		live := item.Status == "queued" || item.Status == "leased"

		if *mode == "deadletter" && live {
			item.Status = "dead-letter"
			item.LeaseOwner = ""
			item.LeaseUntil = ""
			item.BackoffUntil = ""
			item.LastError = "manual ghost queue guard: blocked ai-agent-development-log re-narrativization"
			item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			val, err := json.Marshal(item)
			if err != nil {
				fmt.Fprintf(os.Stderr, "marshal %s: %v\n", item.ID, err)
				os.Exit(1)
			}
			keyCopy := append([]byte(nil), iter.Key()...)
			if err := db.Set(keyCopy, val, pebble.Sync); err != nil {
				fmt.Fprintf(os.Stderr, "deadletter %s: %v\n", item.ID, err)
				os.Exit(1)
			}
			action = "dead-lettered"
			changed++
		} else if *mode == "deadletter" {
			action = "left-unchanged"
		}

		printReport(report{
			Key:       string(iter.Key()),
			ID:        item.ID,
			Found:     true,
			Status:    item.Status,
			Action:    action,
			Item:      item,
			LiveState: live,
		})
	}

	for id := range targets {
		if !seen[id] {
			printReport(report{ID: id, Found: false, Action: "not-found", LiveState: false})
		}
	}

	fmt.Printf("SUMMARY mode=%s changed=%d targets=%s\n", *mode, changed, strings.Join(sortedTargets(), ","))
}

func printReport(r report) {
	b, _ := json.MarshalIndent(r, "", "  ")
	fmt.Println(string(b))
}

func sortedTargets() []string {
	return []string{
		"main:2026-05-01T06-30-35-008Z-0001",
		"main:2026-05-01T06-30-35-023Z-0002",
		"main:2026-05-01T06-30-35-028Z-0003",
	}
}
