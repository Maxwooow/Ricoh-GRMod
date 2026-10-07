//go:build !windows && !linux && !darwin

package platform

func diskUsage(path string) (total, free uint64) { return 0, 0 }
