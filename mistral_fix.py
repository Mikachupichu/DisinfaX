from litellm.integrations.custom_logger import CustomLogger
class MistralScrubber(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type, **kwargs):
        if not isinstance(data, dict):
            return data
        model_name = data.get("model", "").lower()
        if "haiku" in model_name or "mistral" in model_name:
            data.pop("output_config", None)
            data.pop("ignored_parameters", None)
            data.pop("drop_unsupported_params", None)
            data.pop("effort", None)
            if "messages" in data and isinstance(data["messages"], list):
                for msg in data["messages"]:
                    if isinstance(msg, dict) and "content" in msg:
                        content = msg["content"]
                        if isinstance(content, list):
                            clean_content = []
                            for block in content:
                                if isinstance(block, dict):
                                    if block.get("type") in ["thinking", "redacted_thinking"]:
                                        continue
                                clean_content.append(block)
                            if not clean_content:
                                clean_content = [{"type": "text", "text": " "}]
                            msg["content"] = clean_content
        return data
proxy_handler_instance = MistralScrubber()
