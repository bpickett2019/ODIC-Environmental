"""Vercel serverless - just return a simple health check."""

def handler(request):
    """Simple health check endpoint."""
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": '{"status": "ok", "message": "ODIC Environmental API is running"}',
    }
