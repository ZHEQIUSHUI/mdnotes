FROM python:3.12-slim
# Inside China pass --build-arg PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_INDEX=https://pypi.org/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX} fastapi==0.115.6 uvicorn==0.32.1 python-multipart==0.0.20
WORKDIR /app
COPY app.py /app/
COPY static /app/static
ENV DATA_DIR=/data
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
