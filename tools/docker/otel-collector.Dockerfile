FROM otel/opentelemetry-collector-contrib:0.158.0 AS collector

FROM alpine:3.22
RUN addgroup -g 10001 collector \
  && adduser -D -H -u 10001 -G collector collector
COPY --from=collector /otelcol-contrib /otelcol-contrib
USER 10001:10001
ENTRYPOINT ["/otelcol-contrib"]
