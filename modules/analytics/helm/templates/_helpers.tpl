{{/*
Common labels + name helpers.
*/}}

{{- define "gatewaze-analytics.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gatewaze-analytics.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gatewaze-analytics.labels" -}}
app.kubernetes.io/name: {{ include "gatewaze-analytics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "gatewaze-analytics.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gatewaze-analytics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
