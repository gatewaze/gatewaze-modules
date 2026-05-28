{{/*
Helper templates for the prefect-worker subchart.
*/}}

{{- define "prefect-worker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "prefect-worker.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "prefect-worker.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "prefect-worker.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "prefect-worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "prefect-worker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "prefect-worker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "prefect-worker.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Connection URL for Prefect Server → Supabase `prefect` schema.
Assembled from supabase.databaseHost + supabase.databasePassword so the
raw URL is never in values.yaml.
*/}}
{{- define "prefect-worker.databaseUrl" -}}
postgresql+asyncpg://prefect_app:{{ .Values.supabase.databasePassword }}@{{ .Values.supabase.databaseHost }}:5432/postgres?options=-csearch_path%3Dprefect
{{- end }}
