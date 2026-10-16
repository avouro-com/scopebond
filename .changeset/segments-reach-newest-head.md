---
"@scopebond/verify": patch
---

`verifySegmentChain` checks that the segments reach the newest head's sequence. A head names the segment before the batch it answers, so a chain's newest batch could be removed without contradicting any head, and the check still passed. Past the newest head's segment, the segments that continue it must now link one after another, with no fork and no gap, up to the highest sequence number any head of the chain gives. Records that a head says were admitted but that are in no segment given are reported as a problem, and `scopebond verify --segments` exits non-zero.
