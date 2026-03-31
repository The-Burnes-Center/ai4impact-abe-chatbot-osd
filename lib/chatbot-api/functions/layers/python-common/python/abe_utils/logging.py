import json
import logging
import os
from contextvars import ContextVar

_correlation_id: ContextVar[str] = ContextVar("correlation_id", default="")


def set_correlation_id(value: str) -> None:
    """Bind a correlation ID (e.g. session_id) to every log line in this invocation."""
    _correlation_id.set(value)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_obj: dict = {
            "level": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
            "function": os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "unknown"),
        }
        cid = _correlation_id.get()
        if cid:
            log_obj["correlation_id"] = cid
        # X-Ray trace ID — Lambda sets _X_AMZN_TRACE_ID per invocation
        trace_id = os.environ.get("_X_AMZN_TRACE_ID")
        if trace_id:
            log_obj["trace_id"] = trace_id
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_obj)


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(_JsonFormatter())
        logger.addHandler(handler)
        logger.propagate = False
    logger.setLevel(logging.INFO)
    return logger
