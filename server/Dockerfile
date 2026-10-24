# The Endurance vLLM manager. It starts model containers through the Docker socket it is given.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY manager ./manager
EXPOSE 8100
CMD ["python", "-m", "manager"]
