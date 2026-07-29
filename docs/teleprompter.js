/**
 * Intelligent Teleprompter
 * Uses Web Speech API for real-time speech recognition and fuzzy matching
 * to track the speaker's position in the script.
 */

class Teleprompter {
  constructor() {
    this.segments = [];
    this.currentSegmentIndex = 0;
    this.recognition = null;
    this.isListening = false;
    this.spokenWords = [];
    this.matcher = null;
    this.timerInterval = null;
    this.elapsedSeconds = 0;

    this.init();
  }

  init() {
    // Load script from sessionStorage
    const script = sessionStorage.getItem('teleprompter-script');
    if (!script) {
      window.location.href = 'index.html';
      return;
    }

    // Parse script into segments (split by blank lines or newlines)
    this.segments = this.parseScript(script);
    this.matcher = new FuzzyMatcher(this.segments);

    // Start at the first speakable (non-heading) segment
    this.currentSegmentIndex = this.findNextSpeakable(0);

    this.renderSegments();
    this.setupSpeechRecognition();
    this.setupControls();
    this.updateDisplay();
  }

  /**
   * Find the next non-heading segment starting from the given index.
   */
  findNextSpeakable(fromIndex) {
    let idx = fromIndex;
    while (idx < this.segments.length && this.segments[idx].isHeading) {
      idx++;
    }
    return Math.min(idx, this.segments.length - 1);
  }

  parseScript(script) {
    // Split into segments. Each non-empty line becomes its own segment.
    // Lines starting with "#" are decorative/organizational (not spoken).
    const lines = script.split(/\n/);
    const segments = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        const isHeading = trimmed.startsWith('#');
        segments.push({ text: trimmed, isHeading });
      }
    }

    return segments;
  }

  renderSegments() {
    const container = document.getElementById('segments-container');
    container.innerHTML = '';

    this.segments.forEach((segment, index) => {
      const el = document.createElement('div');
      el.className = segment.isHeading ? 'segment heading' : 'segment';
      el.dataset.index = index;
      el.id = `segment-${index}`;

      // Strip markdown formatting for display but keep it readable
      const displayText = this.formatForDisplay(segment.text);
      el.innerHTML = displayText;

      container.appendChild(el);
    });
  }

  formatForDisplay(text) {
    // Simple markdown-like formatting
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^#+\s*(.+)$/gm, '<strong>$1</strong>')
      .replace(/^[-*]\s+(.+)$/gm, '&bull; $1');
  }

  setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      this.setStatus('error', 'Speech Recognition not supported. Please use Chrome or Edge.');
      document.getElementById('start-btn').disabled = true;
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (event) => {
      this.handleSpeechResult(event);
    };

    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'no-speech') {
        // This is normal, just keep listening
        return;
      }
      if (event.error === 'aborted') {
        return;
      }
      this.setStatus('error', `Error: ${event.error}`);
    };

    this.recognition.onend = () => {
      // Auto-restart if we're still supposed to be listening
      if (this.isListening) {
        try {
          this.recognition.start();
        } catch (e) {
          // Ignore - might already be started
        }
      }
    };
  }

  handleSpeechResult(event) {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    // Show what we're hearing in the debug panel
    const debugText = document.getElementById('debug-text');
    if (interimTranscript) {
      debugText.textContent = interimTranscript;
      debugText.className = 'debug-text interim';
    }

    if (finalTranscript) {
      debugText.textContent = finalTranscript;
      debugText.className = 'debug-text final';

      // Process the final transcript for position tracking
      const words = finalTranscript.toLowerCase().trim().split(/\s+/);
      this.spokenWords.push(...words);

      // Use fuzzy matching to determine position
      this.updatePosition();
    }

    // Also try to match interim results for faster response — but only for the immediate next segment
    if (interimTranscript && interimTranscript.split(/\s+/).length >= 4) {
      const words = interimTranscript.toLowerCase().trim().split(/\s+/);
      this.updatePositionInterim(words);
    }
  }

  updatePosition() {
    const newIndex = this.matcher.findBestSegment(this.spokenWords, this.currentSegmentIndex);

    if (newIndex > this.currentSegmentIndex) {
      // Skip past any headings to the next speakable segment
      this.currentSegmentIndex = this.findNextSpeakable(newIndex);
      this.updateDisplay();
    }
  }

  updatePositionInterim(interimWords) {
    // Find the next speakable (non-heading) segment
    let nextIdx = this.currentSegmentIndex + 1;
    while (nextIdx < this.segments.length && this.segments[nextIdx].isHeading) {
      nextIdx++;
    }
    if (nextIdx >= this.segments.length) return;

    const nextSegWords = this.segments[nextIdx].text.toLowerCase().replace(/[^\w\s']/g, '').split(/\s+/);
    const checkWords = nextSegWords.slice(0, Math.min(6, nextSegWords.length));

    // Count sequential matches at the start of the next segment
    let sequentialMatches = 0;
    let segWordIdx = 0;
    
    for (const iw of interimWords) {
      if (segWordIdx >= checkWords.length) break;
      const cleaned = iw.toLowerCase().replace(/[^\w']/g, '');
      if (this.matcher.smartWordDistance(cleaned, checkWords[segWordIdx]) <= 1) {
        sequentialMatches++;
        segWordIdx++;
      }
    }

    // Require at least 4 sequential matches to advance via interim
    if (sequentialMatches >= 4) {
      this.currentSegmentIndex = nextIdx;
      this.updateDisplay();
    }
  }

  updateDisplay() {
    // Update segment classes
    const allSegments = document.querySelectorAll('.segment');
    allSegments.forEach((el, index) => {
      el.classList.remove('past', 'current', 'next', 'future');

      if (index < this.currentSegmentIndex) {
        el.classList.add('past');
      } else if (index === this.currentSegmentIndex) {
        // Headings should never be "current" — they're decorative
        if (this.segments[index].isHeading) {
          el.classList.add('past');
        } else {
          el.classList.add('current');
        }
      } else if (index === this.currentSegmentIndex + 1 || 
                 (this.segments[this.currentSegmentIndex + 1]?.isHeading && index === this.currentSegmentIndex + 2)) {
        el.classList.add('next');
      } else {
        el.classList.add('future');
      }
    });

    // Update sticky heading: find the most recent heading before the current segment
    this.updateStickyHeading();

    // Scroll the current segment into view smoothly
    const currentEl = document.getElementById(`segment-${this.currentSegmentIndex}`);
    if (currentEl) {
      currentEl.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }

  updateStickyHeading() {
    const stickyEl = document.getElementById('sticky-heading');
    let headingText = '';

    // Walk backwards from current position to find the most recent heading
    for (let i = this.currentSegmentIndex; i >= 0; i--) {
      if (this.segments[i].isHeading) {
        headingText = this.formatForDisplay(this.segments[i].text);
        break;
      }
    }

    if (headingText) {
      stickyEl.innerHTML = headingText;
      stickyEl.classList.add('visible');
    } else {
      stickyEl.innerHTML = '';
      stickyEl.classList.remove('visible');
    }
  }

  setupControls() {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const resetBtn = document.getElementById('reset-btn');

    startBtn.addEventListener('click', () => this.startListening());
    stopBtn.addEventListener('click', () => this.stopListening());
    resetBtn.addEventListener('click', () => this.resetPosition());

    // Arrow key navigation for manual override
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.manualAdvance();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.manualRetreat();
      }
    });
  }

  /**
   * Manually advance to the next speakable line (Down arrow)
   */
  manualAdvance() {
    const next = this.findNextSpeakable(this.currentSegmentIndex + 1);
    if (next < this.segments.length) {
      this.currentSegmentIndex = next;
      this.matcher.syncCursorToSegment(next);
      // Mark all current spoken words as processed so they don't re-trigger matching
      this.matcher.totalSpokenProcessed = this.spokenWords.length;
      this.updateDisplay();
    }
  }

  /**
   * Manually retreat to the previous speakable line (Up arrow)
   */
  manualRetreat() {
    let idx = this.currentSegmentIndex - 1;
    while (idx >= 0 && this.segments[idx].isHeading) {
      idx--;
    }
    if (idx >= 0) {
      this.currentSegmentIndex = idx;
      this.matcher.syncCursorToSegment(idx);
      // Mark all current spoken words as processed so they don't re-trigger matching
      this.matcher.totalSpokenProcessed = this.spokenWords.length;
      this.updateDisplay();
    }
  }

  startListening() {
    if (!this.recognition) return;

    try {
      this.recognition.start();
      this.isListening = true;
      this.setStatus('listening', 'Listening...');
      document.getElementById('start-btn').disabled = true;
      document.getElementById('stop-btn').disabled = false;
      this.startTimer();
    } catch (e) {
      console.error('Failed to start recognition:', e);
      this.setStatus('error', 'Failed to start. Check microphone permissions.');
    }
  }

  stopListening() {
    if (!this.recognition) return;

    this.isListening = false;
    this.recognition.stop();
    this.setStatus('offline', 'Stopped');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;
    this.stopTimer();
  }

  resetPosition() {
    this.currentSegmentIndex = 0;
    this.spokenWords = [];
    this.matcher.reset();
    this.updateDisplay();
    this.resetTimer();
    document.getElementById('debug-text').textContent = '—';
  }

  startTimer() {
    if (this.timerInterval) return;
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.updateTimerDisplay();
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  resetTimer() {
    this.stopTimer();
    this.elapsedSeconds = 0;
    this.updateTimerDisplay();
  }

  updateTimerDisplay() {
    const minutes = Math.floor(this.elapsedSeconds / 60);
    const seconds = this.elapsedSeconds % 60;
    const display = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    document.getElementById('timer').textContent = display;
  }

  setStatus(type, text) {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    indicator.className = `status-dot ${type}`;
    statusText.textContent = text;
  }
}

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', () => {
  new Teleprompter();
});
