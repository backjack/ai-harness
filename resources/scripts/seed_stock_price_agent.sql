INSERT INTO agents (
    agent_id, agent_name, description, faq, owner_email, shared_with, model_id, tooling, system_prompts,
    user_prompts, model_type, guardrails, created_by
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    'Stock Price Assistant', 'Provides market-price and portfolio analysis.', JSON_OBJECT(), 'owner@example.com', JSON_ARRAY(), 'gpt-5.4-mini',
    JSON_ARRAY(JSON_OBJECT(
        'name', 'getMarketPrice',
        'description', 'This tool is used for providing live market-price details for a stock ticker.',
        'enabled', TRUE,
        'source_code', 'def getMarketPrice(stock_symbol: str) -> dict[str, object]:\n    """Return live market-price details from Yahoo Finance''s chart API."""\n    import json\n    from urllib.parse import quote\n    from urllib.request import Request, urlopen\n\n    symbol = stock_symbol.strip().upper()\n    if not symbol:\n        return {"error": "stock_symbol is required"}\n\n    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol, safe='''')}?interval=1d&range=1d"\n    try:\n        request = Request(url, headers={"User-Agent": "ai-harness/1.0"})\n        with urlopen(request, timeout=10) as response:\n            payload = json.load(response)\n        result = payload["chart"]["result"][0]\n        meta = result.get("meta", {})\n        price = meta.get("regularMarketPrice")\n        if price is None:\n            closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])\n            price = next((close for close in reversed(closes) if close is not None), None)\n        if price is None:\n            return {"symbol": symbol, "error": "No market price was returned for this ticker"}\n        return {\n            "symbol": meta.get("symbol", symbol),\n            "price": price,\n            "currency": meta.get("currency"),\n            "comment": "Yahoo Finance data may be delayed and is not financial advice."\n        }\n    except Exception as exc:\n        return {"symbol": symbol, "error": f"Unable to retrieve market price: {type(exc).__name__}"}'
    )),
    JSON_ARRAY('You are a stock analyst. Your job is to analyse the user''s portfolio using the getMarketPrice tool.', 'Only respond to questions about stocks and investment portfolios. For any other topic, reply: I can only help with stock and investment portfolio-related questions.'),
    JSON_ARRAY(), 'openai', JSON_OBJECT(
        'allowed_topics', JSON_ARRAY('stocks', 'stock prices', 'equities', 'investment portfolios', 'portfolio analysis'),
        'out_of_scope_response', 'I can only help with stock and investment portfolio-related questions.'
    ), 'owner@example.com'
) ON DUPLICATE KEY UPDATE tooling = VALUES(tooling), system_prompts = VALUES(system_prompts), guardrails = VALUES(guardrails);
