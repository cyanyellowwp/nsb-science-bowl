FROM python:3.12.9-alpine3.20

WORKDIR /app

RUN addgroup -S quiz && adduser -S quiz -G quiz

COPY . /app

RUN chown -R quiz:quiz /app

USER quiz

EXPOSE 8766

CMD ["python3", "-m", "http.server", "8766", "--bind", "0.0.0.0"]
