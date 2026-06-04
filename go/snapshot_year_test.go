// Phase 3.2 small test for handleSnapshotCounterIncrement input validation.
package main

import "testing"

func TestIsFourDigitYear(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"2026", true},
		{"2024", true},  // lower bound
		{"2100", true},  // upper bound
		{"0000", false}, // out of range
		{"9999", false}, // out of range
		{"abcd", false}, // non-numeric
		{"202", false},  // too short
		{"20260", false}, // too long
		{"", false},     // empty
		{"2o26", false}, // mixed
	}
	for _, c := range cases {
		if got := isFourDigitYear(c.in); got != c.want {
			t.Errorf("isFourDigitYear(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
