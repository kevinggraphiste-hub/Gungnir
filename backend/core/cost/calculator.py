import re
from datetime import datetime
from typing import Dict, Optional, Tuple

MODEL_PRICING = {
    "anthropic/claude-3.5-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3.5-haiku": {"input": 0.8, "output": 4.0},
    "anthropic/claude-3-opus": {"input": 15.0, "output": 75.0},
    "anthropic/claude-3-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3-haiku": {"input": 0.8, "output": 4.0},
    "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0},
    "claude-3-5-haiku-20241022": {"input": 0.8, "output": 4.0},
    "claude-3-opus-20240229": {"input": 15.0, "output": 75.0},
    "claude-3-sonnet-20240229": {"input": 3.0, "output": 15.0},
    "claude-3-haiku-20240307": {"input": 0.8, "output": 4.0},
    "openai/gpt-4o": {"input": 2.5, "output": 10.0},
    "openai/gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "openai/gpt-4-turbo": {"input": 10.0, "output": 30.0},
    "openai/gpt-4": {"input": 30.0, "output": 60.0},
    "openai/gpt-3.5-turbo": {"input": 0.5, "output": 1.5},
    "google/gemini-2.0-flash-exp": {"input": 0.1, "output": 0.4},
    "google/gemini-1.5-pro": {"input": 1.25, "output": 5.0},
    "google/gemini-1.5-flash": {"input": 0.075, "output": 0.3},
    "minimax/minimax-m2.7": {"input": 0.1, "output": 0.1},
    "xiaomi/mimo-v2-pro": {"input": 0.1, "output": 0.3},
    "meta-llama/llama-3.1-70b-instruct": {"input": 0.7, "output": 1.2},
    "meta-llama/llama-3.1-8b-instruct": {"input": 0.2, "output": 0.3},
    "meta-llama/llama-3.1-405b-instruct": {"input": 3.5, "output": 4.5},
    "ollama/llama3.2": {"input": 0.0, "output": 0.0},
    "ollama/llama3.1": {"input": 0.0, "output": 0.0},
    "ollama/mistral": {"input": 0.0, "output": 0.0},
    "ollama/codellama": {"input": 0.0, "output": 0.0},
}

def get_model_pricing(model: str) -> Tuple[float, float]:
    """Get input and output pricing per 1M tokens for a model in USD."""
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        # Try stripping date suffix
        stripped = re.sub(r'-\d{8}$', '', model)
        pricing = MODEL_PRICING.get(stripped, {"input": 0.0, "output": 0.0})
    return pricing["input"], pricing["output"]

def calculate_cost(model: str, tokens_input: int, tokens_output: int) -> float:
    """Calculate total cost in USD from token usage."""
    input_cost_per_1m, output_cost_per_1m = get_model_pricing(model)
    
    input_cost = (tokens_input / 1_000_000) * input_cost_per_1m
    output_cost = (tokens_output / 1_000_000) * output_cost_per_1m
    
    return input_cost + output_cost

def extract_model_from_response(response_model: str) -> str:
    """Extract standardized model name from response."""
    if not response_model:
        return "unknown"

    model_lower = response_model.lower()

    # Strip date suffixes like -20260318, -20241022 for matching
    stripped = re.sub(r'-\d{8}$', '', model_lower)

    # Try direct match first (with and without date suffix)
    if stripped in MODEL_PRICING:
        return stripped
    if model_lower in MODEL_PRICING:
        return model_lower

    # Xiaomi MiMo
    if "mimo" in model_lower:
        return "xiaomi/mimo-v2-pro"

    if "claude-3.5-sonnet" in model_lower:
        return "anthropic/claude-3.5-sonnet"
    elif "claude-3.5-haiku" in model_lower:
        return "anthropic/claude-3.5-haiku"
    elif "claude-3-opus" in model_lower:
        return "anthropic/claude-3-opus"
    elif "claude-3-sonnet" in model_lower:
        return "anthropic/claude-3-sonnet"
    elif "claude-3-haiku" in model_lower:
        return "anthropic/claude-3-haiku"
    elif "gpt-4o-mini" in model_lower:
        return "openai/gpt-4o-mini"
    elif "gpt-4o" in model_lower:
        return "openai/gpt-4o"
    elif "gpt-4-turbo" in model_lower:
        return "openai/gpt-4-turbo"
    elif "gpt-4" in model_lower:
        return "openai/gpt-4"
    elif "gpt-3.5-turbo" in model_lower:
        return "openai/gpt-3.5-turbo"
    elif "gemini-2.0-flash" in model_lower:
        return "google/gemini-2.0-flash-exp"
    elif "gemini-1.5-pro" in model_lower:
        return "google/gemini-1.5-pro"
    elif "gemini-1.5-flash" in model_lower:
        return "google/gemini-1.5-flash"
    elif "minimax" in model_lower or "m2.7" in model_lower:
        return "minimax/minimax-m2.7"
    elif "llama-3.1-70b" in model_lower:
        return "meta-llama/llama-3.1-70b-instruct"
    elif "llama-3.1-8b" in model_lower:
        return "meta-llama/llama-3.1-8b-instruct"
    elif "llama-3.1-405b" in model_lower:
        return "meta-llama/llama-3.1-405b-instruct"
    elif "llama3.2" in model_lower:
        return "ollama/llama3.2"
    elif "llama3.1" in model_lower:
        return "ollama/llama3.1"
    elif "mistral" in model_lower:
        return "ollama/mistral"
    elif "codellama" in model_lower:
        return "ollama/codellama"
    
    return response_model

def format_cost(cost: float) -> str:
    """Format cost as readable string."""
    if cost >= 1.0:
        return f"${cost:.3f}"
    elif cost >= 0.01:
        return f"${cost:.3f}"
    elif cost >= 0.001:
        return f"${cost:.4f}"
    else:
        return f"${cost:.6f}"