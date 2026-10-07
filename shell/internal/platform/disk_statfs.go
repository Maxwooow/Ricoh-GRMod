//go:build linux || darwin

package platform

import "syscall"

// diskUsage returns the size and the free space of the filesystem holding
// path, or zeros when it cannot be determined.
func diskUsage(path string) (total, free uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	bs := uint64(st.Bsize)
	return uint64(st.Blocks) * bs, uint64(st.Bavail) * bs
}
