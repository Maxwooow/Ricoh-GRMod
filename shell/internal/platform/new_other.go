//go:build !windows && !darwin

package platform

// New returns the environment-driven host for the headless development build.
func New() Host { return devHost{} }
