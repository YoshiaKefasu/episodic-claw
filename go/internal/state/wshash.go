package state

import (
	"runtime"
	"strings"
)

// AgentWsHash computes a deterministic hash of a workspace path, matching the
// TypeScript convention in src/utils.ts:agentWsHash exactly.
//
// Rules (must match TS side):
//  1. Replace backslashes with forward slashes
//  2. Strip trailing slashes
//  3. On Windows only, lowercase the result
//  4. DJB2 hash with 31-bit mask (& 0x7FFFFFFF)
//  5. Return as base-36 string
//
// SYNC CONTRACT:
//  - Keep this implementation in sync with TS src/utils.ts:agentWsHash
//  - If rules change, update both sides and fixture tests together
//  - Cross-language fixtures in wshash_test.go are mandatory release gate
//
// Critical: uses UTF-16 code units (not Unicode code points) for iteration
// to match JavaScript's charCodeAt behavior, which operates on UTF-16.
func AgentWsHash(agentWs string) string {
	// Step 1: normalize separators
	normalized := strings.ReplaceAll(agentWs, `\`, "/")

	// Step 2: strip trailing slashes
	normalized = strings.TrimRight(normalized, "/")

	// Step 3: lowercase on Windows only (matches TS process.platform === 'win32')
	if runtime.GOOS == "windows" {
		normalized = strings.ToLower(normalized)
	}

	// Step 4: DJB2 hash using UTF-16 code units (matches JS charCodeAt).
	// JS charCodeAt returns a UTF-16 code unit (0–65535).
	// Go's utf16.Encode produces exactly the same code units.
	// For BMP-only strings (the common case for file paths), each rune maps
	// to exactly one uint16. For surrogate pairs (U+10000–U+10FFFF), two
	// uint16 values are produced, matching JS behavior.
	codeUnits := utf16Encode(normalized)

	var hash uint32 = 5381
	for _, cu := range codeUnits {
		hash = ((hash << 5) + hash + uint32(cu)) & 0x7FFFFFFF
	}

	// Step 5: base-36 (matches JS .toString(36))
	return base36Encode(hash)
}

// utf16Encode returns the UTF-16 code units for a string, matching JS charCodeAt.
// For BMP characters (U+0000–U+FFFF), each produces one uint16.
// For supplementary characters (U+10000–U+10FFFF), each produces a surrogate pair.
func utf16Encode(s string) []uint16 {
	runes := []rune(s)
	// Worst case: all BMP, 1 uint16 per rune
	result := make([]uint16, 0, len(runes))
	for _, r := range runes {
		if r <= 0xFFFF {
			result = append(result, uint16(r))
		} else {
			// Surrogate pair calculation — matches JS internal UTF-16 encoding
			// and Go's utf16.Encode behavior.
			r -= 0x10000
			result = append(result, 0xD800+(uint16(r>>10)), 0xDC00+uint16(r&0x3FF))
		}
	}
	return result
}

// base36Encode encodes a uint32 value as a base-36 string (0-9, a-z),
// matching JavaScript's (number).toString(36) for non-negative integers.
func base36Encode(n uint32) string {
	if n == 0 {
		return "0"
	}
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var buf [64]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = digits[n%36]
		n /= 36
	}
	return string(buf[pos:])
}
