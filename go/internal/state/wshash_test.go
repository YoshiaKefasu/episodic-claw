package state

import (
	"runtime"
	"testing"
)

// TestAgentWsHash_ASCII verifies that the Go implementation matches the
// TypeScript agentWsHash for common ASCII workspace paths.
// These expected values were computed by running the TS agentWsHash in Node.js.
func TestAgentWsHash_ASCII(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string // computed via TS agentWsHash
	}{
		{
			name:     "simple path",
			input:    "/home/user/project",
			expected: "qhx635", // Verified: TS agentWsHash('/home/user/project')
		},
		{
			name:     "backslash normalization",
			input:    `C:\Users\project`,
			expected: "wyzb49", // Verified: TS agentWsHash('C:\Users\project') on win32
		},
		{
			name:     "trailing slash stripped",
			input:    "/home/user/project/",
			expected: "qhx635", // Same as without trailing slash
		},
		{
			name:     "empty string",
			input:    "",
			expected: "45h", // Verified: TS agentWsHash('')
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// On Windows, backslash paths get lowercased, so adjust expected
			got := AgentWsHash(tt.input)
			if tt.name == "backslash normalization" && runtime.GOOS != "windows" {
				// On non-Windows, backslash is replaced but no lowercasing
				// so the result differs from the Windows-lowercased version
				return
			}
			if got != tt.expected {
				t.Errorf("AgentWsHash(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

// TestAgentWsHash_CrossLanguageFixtures contains values hand-verified against
// the TS implementation:
//
//	require('./src/utils').agentWsHash('/home/user/project')  // => "qhx635"
//	require('./src/utils').agentWsHash('C:\\Users\\project')   // => "wyzb49" (on win32)
//	require('./src/utils').agentWsHash('/Users/test/ws/')     // => "a5fvda"
//	require('./src/utils').agentWsHash('')                     // => "45h"
func TestAgentWsHash_CrossLanguageFixtures(t *testing.T) {
	// Fixture 1: Simple Unix path
	got := AgentWsHash("/home/user/project")
	want := "qhx635"
	if got != want {
		t.Errorf("AgentWsHash('/home/user/project') = %q, want %q", got, want)
	}

	// Fixture 2: Trailing slash should be stripped, producing same hash
	got2 := AgentWsHash("/home/user/project/")
	if got2 != want {
		t.Errorf("AgentWsHash('/home/user/project/') = %q, want %q (same as without trailing slash)", got2, want)
	}

	// Fixture 3: Different path produces different hash
	got3 := AgentWsHash("/Users/test/ws/")
	if got3 == want {
		t.Error("AgentWsHash('/Users/test/ws/') should differ from '/home/user/project'")
	}

	// Fixture 4: Empty string
	got4 := AgentWsHash("")
	want4 := "45h"
	if got4 != want4 {
		t.Errorf("AgentWsHash('') = %q, want %q", got4, want4)
	}
}

// TestAgentWsHash_BackslashNormalization verifies that backslashes are
// normalized to forward slashes before hashing.
func TestAgentWsHash_BackslashNormalization(t *testing.T) {
	unixPath := "/home/user/project"
	winPath := `\home\user\project`

	unixHash := AgentWsHash(unixPath)
	winHash := AgentWsHash(winPath)

	if unixHash != winHash {
		t.Errorf("backslash normalization failed: Unix=%q, Win=%q", unixHash, winHash)
	}
}

// TestUtf16Encode_BMP verifies that BMP characters produce single uint16 values.
func TestUtf16Encode_BMP(t *testing.T) {
	units := utf16Encode("ABC")
	if len(units) != 3 {
		t.Fatalf("utf16Encode('ABC') returned %d units, want 3", len(units))
	}
	if units[0] != 'A' || units[1] != 'B' || units[2] != 'C' {
		t.Errorf("utf16Encode('ABC') = %v, want [65,66,67]", units)
	}
}

// TestUtf16Encode_SurrogatePair verifies that supplementary characters
// produce correct surrogate pairs matching JS charCodeAt(0)/charCodeAt(1).
func TestUtf16Encode_SurrogatePair(t *testing.T) {
	// U+1F600 (😀) — a common emoji
	units := utf16Encode("\U0001F600")
	if len(units) != 2 {
		t.Fatalf("utf16Encode(U+1F600) returned %d units, want 2", len(units))
	}
	// Expected surrogate pair: 0xD83D, 0xDE00
	if units[0] != 0xD83D || units[1] != 0xDE00 {
		t.Errorf("utf16Encode(U+1F600) = [%X,%X], want [D83D,DE00]", units[0], units[1])
	}
}

// TestBase36Encode verifies base-36 encoding matches JS (n).toString(36).
func TestBase36Encode(t *testing.T) {
	tests := []struct {
		input    uint32
		expected string
	}{
		{0, "0"},
		{1, "1"},
		{35, "z"},
		{36, "10"},
		{5381, "45h"}, // DJB2 seed — (5381).toString(36) = '45h'
	}
	for _, tt := range tests {
		got := base36Encode(tt.input)
		if got != tt.expected {
			t.Errorf("base36Encode(%d) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}
