/**
 * FuzzyMatcher - Intelligent position tracking for teleprompter
 * 
 * Core approach: Track a cursor through the flattened script word array.
 * As the user speaks, we advance the cursor by finding where the spoken words
 * align in the script. The cursor position maps back to a segment index.
 * 
 * This handles:
 * - Verbatim reading (exact match, fast advance)
 * - Paraphrasing (fuzzy word matching with edit distance)
 * - Skipping words or adding filler words
 * - Speech recognition errors
 * - Number words ("one" matches "1", etc.)
 */

class FuzzyMatcher {
  constructor(segments) {
    this.segments = segments;
    // segments are {text, isHeading} objects. Only build words for non-heading segments.
    this.segmentWords = segments.map(s => 
      s.isHeading ? [] : this.normalizeText(s.text).split(/\s+/).filter(w => w.length > 0)
    );

    // Build a flat word array with segment boundary tracking
    // Heading segments contribute no words (they are skipped during matching)
    this.flatWords = [];
    this.wordToSegment = [];
    this.segmentStartIndex = [];
    this.segmentEndIndex = [];

    for (let i = 0; i < this.segmentWords.length; i++) {
      this.segmentStartIndex.push(this.flatWords.length);
      for (const word of this.segmentWords[i]) {
        this.flatWords.push(word);
        this.wordToSegment.push(i);
      }
      this.segmentEndIndex.push(this.flatWords.length - 1);
    }

    // Cursor: our best estimate of where in the script the speaker is
    this.cursor = 0;
    // How many spoken words have been consumed toward the current position
    this.totalSpokenProcessed = 0;

    // Number word mappings for speech recognition
    this.numberWords = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20',
      'thirty': '30', 'forty': '40', 'fifty': '50'
    };
    // Reverse mapping
    this.digitWords = {};
    for (const [word, digit] of Object.entries(this.numberWords)) {
      this.digitWords[digit] = word;
    }
  }

  /**
   * Normalize text: lowercase, strip punctuation, normalize numbers
   */
  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s']/g, '')  // strip punctuation except apostrophes
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Normalize a single spoken word
   */
  normalizeWord(word) {
    return word.toLowerCase().replace(/[^\w']/g, '');
  }

  reset() {
    this.cursor = 0;
    this.totalSpokenProcessed = 0;
  }

  /**
   * Sync the internal cursor to the start of a given segment.
   * Used when the user manually navigates with arrow keys.
   */
  syncCursorToSegment(segmentIndex) {
    if (segmentIndex < this.segmentStartIndex.length) {
      this.cursor = this.segmentStartIndex[segmentIndex];
    }
  }

  /**
   * Main entry point: given all spoken words and current segment, find the best segment.
   */
  findBestSegment(spokenWords, currentSegment) {
    if (spokenWords.length === 0) return currentSegment;

    // Only process new words since last call
    const newWords = spokenWords.slice(this.totalSpokenProcessed);
    this.totalSpokenProcessed = spokenWords.length;

    if (newWords.length === 0) return currentSegment;

    // Clean the new words
    const cleanWords = newWords.map(w => this.normalizeWord(w)).filter(w => w.length > 0);

    if (cleanWords.length === 0) return currentSegment;

    // Advance cursor by aligning new words against the script
    this.advanceCursor(cleanWords);

    // Map cursor position to segment index
    const cursorSegment = this.getCursorSegment();

    // Never go backwards
    return Math.max(currentSegment, cursorSegment);
  }

  /**
   * Advance the cursor position based on newly spoken words.
   * CONSTRAINT: The cursor can only advance within the current segment
   * or into the immediately next segment. It cannot skip multiple segments.
   */
  advanceCursor(spokenWords) {
    let spokenIdx = 0;
    
    while (spokenIdx < spokenWords.length) {
      const word = spokenWords[spokenIdx];
      
      // Skip common filler words that speech recognition picks up
      if (this.isFillerWord(word)) {
        spokenIdx++;
        continue;
      }

      // Determine the allowed search boundary: only current segment + next segment
      const currentSeg = this.cursor < this.flatWords.length 
        ? this.wordToSegment[this.cursor] 
        : this.segments.length - 1;
      const nextSeg = Math.min(currentSeg + 1, this.segments.length - 1);
      
      // Only search up to the end of the NEXT segment (can't skip further)
      const maxSearchPos = nextSeg < this.segments.length - 1
        ? this.segmentStartIndex[nextSeg + 1]
        : this.flatWords.length;
      
      // Also limit look-ahead to 20 words to avoid distant false matches
      const searchEnd = Math.min(this.cursor + 20, maxSearchPos);

      // Try to find this word in the allowed range
      let bestPos = -1;
      let bestDist = Infinity;
      
      for (let pos = this.cursor; pos < searchEnd; pos++) {
        const dist = this.smartWordDistance(word, this.flatWords[pos]);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
          if (dist === 0) break; // Exact match, take it
        }
      }

      // If we found a reasonable match
      if (bestDist <= this.getMaxEditDistance(word) && bestPos >= 0) {
        const jump = bestPos - this.cursor;
        
        if (jump <= 3) {
          // Small jump: normal reading flow
          this.cursor = bestPos + 1;
        } else {
          // Larger jump within allowed range: confirm with following words
          const confirmed = this.confirmJump(spokenWords, spokenIdx, bestPos);
          if (confirmed) {
            this.cursor = bestPos + 1;
          }
          // If not confirmed, don't advance — ignore this word
        }
      }
      
      spokenIdx++;
    }
  }

  /**
   * Check if a word is a common filler
   */
  isFillerWord(word) {
    const fillers = new Set(['um', 'uh', 'ah', 'er', 'like', 'you know', 'so', 'well', 'basically']);
    return fillers.has(word);
  }

  /**
   * Confirm a larger jump by checking if subsequent spoken words also match
   * the script at and after the proposed position.
   */
  confirmJump(spokenWords, startIdx, scriptPos) {
    let matches = 0;
    let checks = 0;
    
    for (let i = 1; i <= 3 && startIdx + i < spokenWords.length; i++) {
      const spoken = spokenWords[startIdx + i];
      if (this.isFillerWord(spoken)) continue;
      
      const nextScriptPos = scriptPos + i;
      if (nextScriptPos >= this.flatWords.length) break;
      
      checks++;
      const dist = this.smartWordDistance(spoken, this.flatWords[nextScriptPos]);
      if (dist <= this.getMaxEditDistance(spoken)) {
        matches++;
      }
    }

    // Need at least 2 additional matches to confirm a big jump,
    // or 1 match if we only had 1-2 words to check
    if (checks === 0) return false; // Can't confirm without more words
    if (checks <= 2) return matches >= 1;
    return matches >= 2;
  }

  /**
   * Get the segment index for the current cursor position.
   * Only advances to the next segment when the speaker has meaningfully
   * progressed through the current segment.
   * Headings are auto-skipped (they have no words in the flat array).
   */
  getCursorSegment() {
    if (this.cursor <= 0) {
      // Find the first speakable segment
      return this.skipHeadings(0);
    }
    if (this.cursor >= this.flatWords.length) return this.segments.length - 1;

    // Find which segment the cursor is currently in
    const cursorPos = Math.min(this.cursor, this.flatWords.length - 1);
    const currentSeg = this.wordToSegment[cursorPos];

    // Check how far into the current segment we are
    const segStart = this.segmentStartIndex[currentSeg];
    const segLength = this.segmentWords[currentSeg].length;
    const posInSegment = cursorPos - segStart;

    // For short segments (≤ 5 words like headings), only advance once the cursor
    // has actually entered the next segment
    if (segLength <= 5) {
      return currentSeg;
    }

    // For longer segments, only advance when we've read past 85% of it
    if (posInSegment >= segLength * 0.85 && currentSeg + 1 < this.segments.length) {
      return this.skipHeadings(currentSeg + 1);
    }

    return currentSeg;
  }

  /**
   * Given a segment index, skip forward past any heading segments
   * to find the next speakable segment.
   */
  skipHeadings(startIdx) {
    let idx = startIdx;
    while (idx < this.segments.length && this.segments[idx].isHeading) {
      idx++;
    }
    // If we ran past the end, return the last segment
    return Math.min(idx, this.segments.length - 1);
  }

  /**
   * Smart word distance that handles number words
   * "one" should match "1", "two" should match "2", etc.
   */
  smartWordDistance(spoken, script) {
    if (spoken === script) return 0;

    // Check number word ↔ digit match
    const spokenAsDigit = this.numberWords[spoken];
    const scriptAsDigit = this.numberWords[script];
    const spokenAsWord = this.digitWords[spoken];
    const scriptAsWord = this.digitWords[script];

    if (spokenAsDigit && spokenAsDigit === script) return 0;
    if (scriptAsDigit && scriptAsDigit === spoken) return 0; 
    if (spokenAsWord && spokenAsWord === script) return 0;
    if (scriptAsWord && scriptAsWord === spoken) return 0;

    // Also check digit-to-digit after normalization
    if (spokenAsDigit && scriptAsDigit && spokenAsDigit === scriptAsDigit) return 0;

    // Fall back to edit distance
    return this.wordDistance(spoken, script);
  }

  /**
   * Calculate edit distance between two words
   */
  wordDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Quick reject
    if (Math.abs(a.length - b.length) > 3) return Math.abs(a.length - b.length);

    const m = a.length;
    const n = b.length;
    const dp = new Array(n + 1);

    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        if (a[i - 1] === b[j - 1]) {
          dp[j] = prev;
        } else {
          dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
        }
        prev = temp;
      }
    }

    return dp[n];
  }

  /**
   * Maximum allowed edit distance for a word to be considered a match
   */
  getMaxEditDistance(word) {
    if (word.length <= 3) return 0;  // Short words must be exact (a, the, is, etc.)
    if (word.length <= 5) return 1;
    return 2;
  }

  /**
   * Calculate similarity between two word arrays (used for interim matching)
   */
  calculateSimilarity(words1, words2) {
    if (words1.length === 0 || words2.length === 0) return 0;

    let matches = 0;
    const used = new Set();

    for (const w1 of words1) {
      for (let j = 0; j < words2.length; j++) {
        if (!used.has(j) && this.smartWordDistance(w1, words2[j]) <= this.getMaxEditDistance(w1)) {
          matches++;
          used.add(j);
          break;
        }
      }
    }

    return matches / Math.max(words1.length, words2.length);
  }
}
