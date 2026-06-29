{{- define "rpa.name" -}}
rpa-enterprise
{{- end -}}

{{- define "rpa.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride -}}
{{- end -}}

{{- define "rpa.image" -}}
{{- $repository := required "image.repository is required; release values must use an owner-approved image repository" .Values.image.repository -}}
{{- $digest := default "" .Values.image.digest -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "image.digest must be an immutable sha256 digest such as sha256:<64 lowercase hex characters>" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- else -}}
{{- $tag := required "image.tag is required when image.digest is empty; release values must prefer image.digest" .Values.image.tag -}}
{{- if or (eq $tag "latest") (eq $tag "placeholder") (regexMatch "^replace.?me$" $tag) -}}
{{- fail "image.tag must not be latest or placeholder-like; release values must prefer image.digest" -}}
{{- end -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "rpa.labels" -}}
app.kubernetes.io/name: {{ include "rpa.name" . }}
app.kubernetes.io/part-of: rpa-enterprise
app.kubernetes.io/managed-by: Helm
{{- end -}}
