package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"
)

// Response structures matching the frontend expectations
type Format struct {
	URL        string `json:"url"`
	Ext        string `json:"ext"`
	FormatNote string `json:"format_note"`
	Resolution string `json:"resolution,omitempty"`
	Filesize   int64  `json:"filesize,omitempty"`
	HasVideo   bool   `json:"hasVideo"`
	HasAudio   bool   `json:"hasAudio"`
}

type ScrapeResult struct {
	Title      string   `json:"title"`
	Thumbnail  string   `json:"thumbnail"`
	Duration   string   `json:"duration"`
	Platform   string   `json:"platform"`
	Formats    []Format `json:"formats"`
	IsPlaylist bool     `json:"isPlaylist"`
	Source     string   `json:"source"`
}

func main() {
	http.HandleFunc("/extract", extractHandler)
	http.HandleFunc("/wake", wakeHandler)

	port := "8080"
	fmt.Printf("Omni Scraper (Go) starting on port %s...\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func wakeHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(map[string]string{"status": "online", "message": "Omni Scraper is awake"})
}

func extractHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	fmt.Printf("[Scrape] Analyzing: %s\n", req.URL)

	// Execute yt-dlp to get metadata
	// -J: JSON output
	// --flat-playlist: Don't extract every video in a playlist yet
	cmd := exec.Command("yt-dlp", "-J", "--flat-playlist", req.URL)
	output, err := cmd.Output()
	if err != nil {
		fmt.Printf("[Error] yt-dlp failed: %v\n", err)
		http.Error(w, "yt-dlp extraction failed", http.StatusInternalServerError)
		return
	}

	var rawData map[string]interface{}
	if err := json.Unmarshal(output, &rawData); err != nil {
		http.Error(w, "Failed to parse yt-dlp output", http.StatusInternalServerError)
		return
	}

	result := parseYtDlpOutput(rawData)
	result.Source = "yt-dlp (Raspberry Pi Go Backend)"

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func parseYtDlpOutput(data map[string]interface{}) ScrapeResult {
	res := ScrapeResult{
		Title:     getString(data, "title"),
		Thumbnail: getString(data, "thumbnail"),
		Duration:  formatDuration(getFloat(data, "duration")),
		Platform:  getString(data, "extractor"),
	}

	// Check if it's a playlist
	if _, ok := data["entries"]; ok {
		res.IsPlaylist = true
		return res
	}

	// Extract formats
	if formatsRaw, ok := data["formats"].([]interface{}); ok {
		for _, fRaw := range formatsRaw {
			f := fRaw.(map[string]interface{})
			
			// Only keep formats with direct URLs
			url := getString(f, "url")
			if url == "" || strings.Contains(getString(f, "protocol"), "m3u8") {
				continue
			}

			hasVideo := getString(f, "vcodec") != "none"
			hasAudio := getString(f, "acodec") != "none"

			format := Format{
				URL:        url,
				Ext:        getString(f, "ext"),
				FormatNote: getString(f, "format_note"),
				Resolution: getString(f, "resolution"),
				Filesize:   int64(getFloat(f, "filesize")),
				HasVideo:   hasVideo,
				HasAudio:   hasAudio,
			}
			res.Formats = append(res.Formats, format)
		}
	}

	return res
}

func getString(m map[string]interface{}, key string) string {
	if val, ok := m[key].(string); ok {
		return val
	}
	return ""
}

func getFloat(m map[string]interface{}, key string) float64 {
	if val, ok := m[key].(float64); ok {
		return val
	}
	return 0
}

func formatDuration(seconds float64) string {
	s := int(seconds)
	h := s / 3600
	m := (s % 3600) / 60
	sec := s % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%d:%02d", m, sec)
}
