package proxy

import "kiro-proxy/config"

// requestLogModel is the model a request row names: the one the request runs on after the
// model mappings and the thinking suffix, as its success row would name it.
func requestLogModel(model string) string {
	mapped, _ := ParseModelAndThinking(model, config.GetThinkingConfig().Suffix)
	return mapped
}
