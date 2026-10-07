package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"

	"grmod/shell/internal/pathguard"
)

// Error codes of the API.
const (
	codeForbidden = "forbidden"
	codeNotFound  = "not-found"
	codeExists    = "exists"
	codeInvalid   = "invalid"
	codeIO        = "io"
	codeTooLarge  = "too-large"
	codeCancelled = "cancelled"
)

// statusClientClosed is the conventional (nginx) status for a request whose
// client went away; nobody is left to read it, it only shows up in the log.
const statusClientClosed = 499

// apiError is an error with a fixed API representation.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.code + ": " + e.message }

func errf(status int, code, format string, a ...any) *apiError {
	return &apiError{status: status, code: code, message: fmt.Sprintf(format, a...)}
}

func errForbidden(format string, a ...any) *apiError {
	return errf(http.StatusForbidden, codeForbidden, format, a...)
}
func errNotFound(format string, a ...any) *apiError {
	return errf(http.StatusNotFound, codeNotFound, format, a...)
}
func errExists(format string, a ...any) *apiError {
	return errf(http.StatusConflict, codeExists, format, a...)
}
func errInvalid(format string, a ...any) *apiError {
	return errf(http.StatusBadRequest, codeInvalid, format, a...)
}
func errIO(format string, a ...any) *apiError {
	return errf(http.StatusInternalServerError, codeIO, format, a...)
}
func errTooLarge(limit int64) *apiError {
	return errf(http.StatusRequestEntityTooLarge, codeTooLarge, "larger than the limit of %d bytes", limit)
}

// toAPIError maps any error to its API representation.
func toAPIError(err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	switch pathguard.KindOf(err) {
	case pathguard.Invalid:
		return errInvalid("%v", err)
	case pathguard.Forbidden:
		return errForbidden("%v", err)
	case pathguard.NotFound:
		return errNotFound("%v", err)
	}
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		return errTooLarge(tooLarge.Limit)
	case errors.Is(err, fs.ErrNotExist):
		return errNotFound("%v", err)
	case errors.Is(err, fs.ErrExist):
		return errExists("%v", err)
	}
	return errIO("%v", err)
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status, body = http.StatusInternalServerError, []byte(`{"error":{"code":"io","message":"cannot encode response"}}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(append(body, '\n'))
}

func writeError(w http.ResponseWriter, e *apiError) {
	writeJSON(w, e.status, errorBody{Error: errorDetail{Code: e.code, Message: e.message}})
}
