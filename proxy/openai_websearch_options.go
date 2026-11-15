package proxy

import (
	"encoding/json"
	"strings"
)

// webSearchContextResults is how many results each search keeps for Chat's
// web_search_options.search_context_size. Kiro's search returns up to 10 results; medium keeps
// the default.
var webSearchContextResults = map[string]int{"low": 3, "medium": defaultWebSearchResults, "high": 10}

// maxWebSearchLocationField caps each user_location field, which is free text, in the tool
// description the model reads.
const maxWebSearchLocationField = 80

// OpenAIWebSearchOptions is Chat Completions' web_search_options, the search form OpenAI's
// Chat search models take. Any object turns hosted web search on, as tools:[{"type":
// "web_search"}] does. A field the proxy cannot use is ignored, never an error.
type OpenAIWebSearchOptions struct {
	// on is whether the request asked for search: an object does, any other value does not.
	on bool
	// results is how many results each search keeps, 0 for defaultWebSearchResults.
	results int
	// location is user_location as text for the model, "" for none.
	location string
}

func (o *OpenAIWebSearchOptions) UnmarshalJSON(data []byte) error {
	*o = OpenAIWebSearchOptions{}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return nil
	}
	o.on = true
	var size string
	if json.Unmarshal(raw["search_context_size"], &size) == nil {
		o.results = webSearchContextResults[strings.ToLower(strings.TrimSpace(size))]
	}
	o.location = webSearchLocationText(raw["user_location"])
	return nil
}

// webSearchLocationText writes user_location as text: "city, region, country (time zone
// tz)". OpenAI nests the fields in approximate; some clients send them flat, which is read too.
func webSearchLocationText(data json.RawMessage) string {
	var location map[string]json.RawMessage
	if json.Unmarshal(data, &location) != nil || location == nil {
		return ""
	}
	var approximate map[string]json.RawMessage
	if json.Unmarshal(location["approximate"], &approximate) != nil || approximate == nil {
		approximate = location
	}
	field := func(name string) string {
		var value string
		if json.Unmarshal(approximate[name], &value) != nil {
			return ""
		}
		value = strings.Join(strings.Fields(value), " ")
		if r := []rune(value); len(r) > maxWebSearchLocationField {
			value = string(r[:maxWebSearchLocationField])
		}
		return value
	}
	var parts []string
	for _, name := range []string{"city", "region", "country"} {
		if value := field(name); value != "" {
			parts = append(parts, value)
		}
	}
	text := strings.Join(parts, ", ")
	if tz := field("timezone"); tz != "" {
		if text == "" {
			return "time zone " + tz
		}
		text += " (time zone " + tz + ")"
	}
	return text
}

// hostedWebSearchDescription is the description of the hosted web_search tool the model sees.
// Kiro's search takes only a query, so the user's location reaches it through the queries the
// model writes.
func hostedWebSearchDescription(location string) string {
	const base = "Search the web for current information."
	if location == "" {
		return base
	}
	return base + " The user is approximately in " + location + ". When the answer depends on where the user is, put the place in the query."
}

// applyChatWebSearchOptions turns Chat's web_search_options into the hosted web_search tool:
// the tool the request already declares, or a new one, so the reply searches exactly as the
// tools form does.
func applyChatWebSearchOptions(req *OpenAIRequest) {
	options := req.WebSearchOptions
	if options == nil || !options.on {
		return
	}
	declared := false
	for i := range req.Tools {
		if isHostedWebSearchToolType(req.Tools[i].Type) {
			req.Tools[i].searchResults, req.Tools[i].searchLocation = options.results, options.location
			declared = true
		}
	}
	if !declared {
		req.Tools = append(req.Tools, OpenAITool{Type: webSearchToolName, searchResults: options.results, searchLocation: options.location})
	}
}
