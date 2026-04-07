package logger

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// LogLevel represents the severity of a log entry.
type LogLevel string

const (
	LevelDebug LogLevel = "debug"
	LevelInfo  LogLevel = "info"
	LevelWarn  LogLevel = "warn"
	LevelError LogLevel = "error"
)

// LogCategory represents the subsystem that produced a log entry.
type LogCategory string

const (
	CatCore          LogCategory = "core"
	CatBackground    LogCategory = "background"
	CatConsolidation LogCategory = "consolidation"
	CatStore         LogCategory = "store"
	CatLexical       LogCategory = "lexical"
	CatWatcher       LogCategory = "watcher"
	CatAI            LogCategory = "ai"
)

var (
	mu          sync.Mutex
	logFile     *os.File
	encoder     *json.Encoder
	currentDate string
	logDir      string
)

// LogEntry is the JSON structure written to the daily log file.
type LogEntry struct {
	Timestamp string      `json:"timestamp"`
	Level     LogLevel    `json:"level"`
	Category  LogCategory `json:"category"`
	Message   string      `json:"message"`
}

// Init sets up the daily log file and returns the base directory path.
// Safe for concurrent use — acquires mu before rotating.
func Init() string {
	logDir = filepath.Join(os.TempDir(), "episodic-claw")
	os.MkdirAll(logDir, 0755)
	mu.Lock()
	rotateIfNeeded()
	mu.Unlock()
	return logDir
}

// rotateIfNeeded creates a new daily log file if the date has changed.
// MUST be called while holding mu.
func rotateIfNeeded() {
	today := time.Now().Format("2006-01-02")
	if today == currentDate && logFile != nil {
		return
	}

	// Close old file
	if logFile != nil {
		logFile.Close()
		logFile = nil
		encoder = nil
	}

	currentDate = today
	path := filepath.Join(logDir, today+".log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[logger] Failed to open log file %s: %v\n", path, err)
		currentDate = "" // Force retry on next Emit call
		return
	}
	logFile = f
	encoder = json.NewEncoder(f)

	// Cleanup old files and directories (keep 3 days)
	cleanupOldFiles(logDir, 3)
}

// cleanupOldFiles removes .log files and date-named directories older than keepDays.
func cleanupOldFiles(dir string, keepDays int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -keepDays)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			// Old-style directory (YYYY-MM-DD/)
			dirDate, err := time.Parse("2006-01-02", name)
			if err == nil && dirDate.Before(cutoff) {
				os.RemoveAll(filepath.Join(dir, name))
			}
			continue
		}
		if filepath.Ext(name) != ".log" {
			continue
		}
		fileDate, err := time.Parse("2006-01-02", name[:len(name)-4])
		if err != nil {
			continue
		}
		if fileDate.Before(cutoff) {
			os.Remove(filepath.Join(dir, name))
		}
	}
}

// Emit writes a log entry to the daily JSONL log file and stderr.
// Thread-safe. If file logging is unavailable, stderr is still written.
func Emit(level LogLevel, cat LogCategory, format string, a ...interface{}) {
	msg := fmt.Sprintf(format, a...)
	ts := time.Now().Format(time.RFC3339)

	// Always write to stderr (captured by TypeScript plugin → OpenClaw logs)
	prefix := fmt.Sprintf("[%s] [%s] %s", cat, level, msg)
	fmt.Fprintln(os.Stderr, prefix)

	// Write to daily log file
	mu.Lock()
	defer mu.Unlock()

	rotateIfNeeded()
	if encoder == nil {
		return
	}
	encoder.Encode(LogEntry{
		Timestamp: ts,
		Level:     level,
		Category:  cat,
		Message:   msg,
	})
}

// Convenience wrappers
func Info(cat LogCategory, format string, a ...interface{})  { Emit(LevelInfo, cat, format, a...) }
func Warn(cat LogCategory, format string, a ...interface{})  { Emit(LevelWarn, cat, format, a...) }
func Error(cat LogCategory, format string, a ...interface{}) { Emit(LevelError, cat, format, a...) }
func Debug(cat LogCategory, format string, a ...interface{}) { Emit(LevelDebug, cat, format, a...) }
