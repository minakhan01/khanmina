(function(global, module, define) {
// A variable that can be used to interrupt things.
var interrupted = false;

// Tests for the presence of HTML5 Web Audio (or webkit's version).
function isAudioPresent() {
  return !!(global.AudioContext || global.webkitAudioContext);
}

// All our audio funnels through the same AudioContext with a
// DynamicsCompressorNode used as the main output, to compress the
// dynamic range of all audio.  getAudioTop sets this up.
function getAudioTop() {
  if (getAudioTop.audioTop) { return getAudioTop.audioTop; }
  if (!isAudioPresent()) {
    return null;
  }
  var ac = new (global.AudioContext || global.webkitAudioContext);
  getAudioTop.audioTop = {
    ac: ac,
    wavetable: makeWavetable(ac),
    out: null,
    currentStart: null
  };
  resetAudio();
  return getAudioTop.audioTop;
}

// When audio needs to be interrupted globally (e.g., when you press the
// stop button in the IDE), resetAudio does the job.
function resetAudio() {
  if (getAudioTop.audioTop) {
    var atop = getAudioTop.audioTop;
    // Disconnect the top-level node and make a new one.
    if (atop.out) {
      atop.out.disconnect();
      atop.out = null;
      atop.currentStart = null;
    }
    var dcn = atop.ac.createDynamicsCompressor();
    dcn.ratio = 16;
    dcn.attack = 0.0005;
    dcn.connect(atop.ac.destination);
    atop.out = dcn;
  }
}

// For precise scheduling of future notes, the AudioContext currentTime is
// cached and is held constant until the script releases to the event loop.
function audioCurrentStartTime() {
  var atop = getAudioTop();
  if (atop.currentStart != null) {
    return atop.currentStart;
  }
  // A delay could be added below to introduce a universal delay in
  // all beginning sounds (without skewing durations for scheduled
  // sequences).
  atop.currentStart = Math.max(0.25, atop.ac.currentTime /* + 0.0 delay */);
  setTimeout(function() { atop.currentStart = null; }, 0);
  return atop.currentStart;
}

// Converts a midi note number to a frequency in Hz.
function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
// Some constants.
var noteNum =
    {C:0,D:2,E:4,F:5,G:7,A:9,B:11,c:12,d:14,e:16,f:17,g:19,a:21,b:23};
var accSym =
    { '^':1, '': 0, '=':0, '_':-1 };
var noteName =
    ['C', '^C', 'D', '_E', 'E', 'F', '^F', 'G', '_A', 'A', '_B', 'B',
     'c', '^c', 'd', '_e', 'e', 'f', '^f', 'g', '_a', 'a', '_b', 'b'];
// Converts a frequency in Hz to the closest midi number.
function frequencyToMidi(freq) {
  return Math.round(69 + Math.log(freq / 440) * 12 / Math.LN2);
}
// Converts an ABC pitch (such as "^G,,") to a midi note number.
function pitchToMidi(pitch) {
  var m = /^(\^+|_+|=|)([A-Ga-g])([,']*)$/.exec(pitch);
  if (!m) { return null; }
  var octave = m[3].replace(/,/g, '').length - m[3].replace(/'/g, '').length;
  var semitone =
      noteNum[m[2]] + accSym[m[1].charAt(0)] * m[1].length + 12 * octave;
  return semitone + 60; // 60 = midi code middle "C".
}
// Converts a midi number to an ABC notation pitch.
function midiToPitch(midi) {
  var index = ((midi - 72) % 12);
  if (midi > 60 || index != 0) { index += 12; }
  var octaves = Math.round((midi - index - 60) / 12),
      result = noteName[index];
  while (octaves != 0) {
    result += octaves > 0 ? "'" : ",";
    octaves += octaves > 0 ? -1 : 1;
  }
  return result;
}
// Converts an ABC pitch to a frequency in Hz.
function pitchToFrequency(pitch) {
  return midiToFrequency(pitchToMidi(pitch));
}

// All further details of audio handling are encapsulated in the Instrument
// class, which knows how to synthesize a basic timbre; how to play and
// schedule a tone; and how to parse and sequence a song written in ABC
// notation.
var Instrument = (function() {
  // The constructor accepts a timbre string or object, specifying
  // its default sound.  The main mechanisms in Instrument are for handling
  // sequencing of a (potentially large) set of notes over a (potentially
  // long) period of time.  The overall strategy:
  //
  //                       Events:      'noteon'        'noteoff'
  //                                      |               |
  // tone()-(quick tones)->| _startSet -->| _finishSet -->| _cleanupSet -->|
  //   \                   |  /           | Playing tones | Done tones     |
  //    \---- _queue ------|-/                                             |
  //      of future tones  |3 secs ahead sent to WebAudio, removed when done
  //
  // The reason for this queuing is to reduce the complexity of the
  // node graph sent to WebAudio: at any time, WebAudio is only
  // responsible for about 2 seconds of music.  If a graph with too
  // too many nodes is sent to WebAudio at once, output distorts badly.
  function Instrument(options) {
    this._atop = getAudioTop();    // Audio context.
    this._timbre = makeTimbre(options, this._atop); // The instrument's timbre.
    this._queue = [];              // A queue of future tones to play.
    this._minQueueTime = Infinity; // The earliest time in _queue.
    this._maxScheduledTime = 0;    // The latest time in _queue.
    this._unsortedQueue = false;   // True if _queue is unsorted.
    this._startSet = [];           // Unstarted tones already sent to WebAudio.
    this._finishSet = {};          // Started tones playing in WebAudio.
    this._cleanupSet = [];         // Tones waiting for cleanup.
    this._callbackSet = [];        // A set of scheduled callbacks.
    this._handlers = {};           // 'noteon' and 'noteoff' handlers.
    this._now = null;              // A cached current-time value.
    if (isAudioPresent()) {
      this.silence();              // Initializes top-level audio node.
    }
  }

  Instrument.timeOffset = 0.0625;// Seconds to delay all audiable timing.
  Instrument.dequeueTime = 0.5;  // Seconds before an event to reexamine queue.
  Instrument.bufferSecs = 2;     // Seconds ahead to put notes in WebAudio.
  Instrument.toneLength = 1;     // Default duration of a tone.
  Instrument.cleanupDelay = 0.1; // Silent time before disconnecting nodes.

  // Sets the default timbre for the instrument.  See defaultTimbre.
  Instrument.prototype.setTimbre = function(t) {
    this._timbre = makeTimbre(t, this._atop);     // Saves a copy.
  };

  // Returns the default timbre for the instrument as an object.
  Instrument.prototype.getTimbre = function(t) {
    return makeTimbre(this._timbre, this._atop);  // Makes a copy.
  };

  // Sets the overall volume for the instrument immediately.
  Instrument.prototype.setVolume = function(v) {
    // Without an audio system, volume cannot be set.
    if (!this._out) { return; }
    if (!isNaN(v)) {
      this._out.gain.value = v;
    }
  };

  // Sets the overall volume for the instrument.
  Instrument.prototype.getVolume = function(v) {
    // Without an audio system, volume is stuck at zero.
    if (!this._out) { return 0.0; }
    return this._out.gain.value;
  };

  // Silences the instrument immediately by reinitializing the audio
  // graph for this instrument and emptying or flushing all queues in the
  // scheduler.  Carefully notifies all notes that have started but not
  // yet finished, and sequences that are awaiting scheduled callbacks.
  // Does not notify notes that have not yet started.
  Instrument.prototype.silence = function() {
    var j, finished, callbacks, initvolume = 1;

    // Clear future notes.
    this._queue.length = 0;
    this._minQueueTime = Infinity;
    this._maxScheduledTime = 0;

    // Don't notify notes that haven't started yet.
    this._startSet.length = 0;

    // Flush finish callbacks that are promised.
    finished = this._finishSet;
    this._finishSet = {};

    // Flush one-time callacks that are promised.
    callbacks = this._callbackSet;
    this._callbackSet = [];

    // Disconnect the audio graph for this instrument.
    if (this._out) {
      this._out.disconnect();
      initvolume = this._out.gain.value;
    }

    // Reinitialize the audio graph: all audio for the instrument
    // multiplexes through a single gain node with a master volume.
    this._atop = getAudioTop();
    this._out = this._atop.ac.createGain();
    this._out.gain.value = initvolume;
    this._out.connect(this._atop.out);

    // As a last step, call all promised notifications.
    for (j in finished) { this._trigger('noteoff', finished[j]); }
    for (j = 0; j < callbacks.length; ++j) { callbacks[j].callback(); }
  };

  // Future notes are scheduled relative to now(), which provides
  // access to audioCurrentStartTime(), a time that holds steady
  // until the script releases to the event loop.  When _now is
  // non-null, it indicates that scheduling is already in progress.
  // The timer-driven _doPoll function clears the cached _now.
  Instrument.prototype.now = function() {
    if (this._now != null) {
      return this._now;
    }
    this._startPollTimer(true);  // passing (true) sets this._now.
    return this._now;
  };

  // Register an event handler.  Done without jQuery to reduce dependencies.
  Instrument.prototype.on = function(eventname, cb) {
    if (!this._handlers.hasOwnProperty(eventname)) {
      this._handlers[eventname] = [];
    }
    this._handlers[eventname].push(cb);
  };

  // Unregister an event handler.  Done without jQuery to reduce dependencies.
  Instrument.prototype.off = function(eventname, cb) {
    if (this._handlers.hasOwnProperty(eventname)) {
      if (!cb) {
        this._handlers[eventname] = [];
      } else {
        var j, hunt = this._handlers[eventname];
        for (j = 0; j < hunt.length; ++j) {
          if (hunt[j] === cb) {
            hunt.splice(j, 1);
            j -= 1;
          }
        }
      }
    }
  };

  // Trigger an event, notifying any registered handlers.
  Instrument.prototype._trigger = function(eventname, record) {
    var cb = this._handlers[eventname], j;
    if (!cb) { return; }
    if (cb.length == 1) {
      // Special, common case of one handler: no copy needed.
      cb[0](record);
      return;
    }
    // Copy the array of callbacks before iterating, because the
    // main this._handlers copy could be changed by a handler.
    // You get notified if-and-only-if you are registered
    // at the starting moment of _trigger.
    cb = cb.slice();
    for (j = 0; j < cb.length; ++j) {
      cb[j](record);
    }
  };

  // Tells the WebAudio API to play a tone (now or soon).  The passed
  // record specifies a start time and release time, an ADSR envelope,
  // and other timbre parameters.  This function sets up a WebAudio
  // node graph for the tone generators and filters for the tone.
  Instrument.prototype._makeSound = function(record) {
    var timbre = record.timbre || this._timbre,
        starttime = record.time + Instrument.timeOffset,
        releasetime = starttime + record.duration,
        attacktime = Math.min(releasetime, starttime + timbre.attack),
        decaytime = timbre.decay *
            Math.pow(440 / record.frequency, timbre.decayfollow),
        decaystarttime = attacktime,
        stoptime = releasetime + timbre.release,
        doubled = timbre.detune && timbre.detune != 1.0,
        amp = timbre.gain * record.velocity * (doubled ? 0.5 : 1.0),
        ac = this._atop.ac,
        g, f, o, o2, pwave, k, wf, bwf;
    // Only hook up tone generators if it is an audible sound.
    if (record.duration > 0 && record.velocity > 0) {
      g = ac.createGain();
      g.gain.setValueAtTime(0, starttime);
      g.gain.linearRampToValueAtTime(amp, attacktime);
      // For the beginning of the decay, use linearRampToValue instead
      // of setTargetAtTime, because it avoids http://crbug.com/254942.
      while (decaystarttime < attacktime + 1/32 &&
             decaystarttime + 1/256 < releasetime) {
        // Just trace out the curve in increments of 1/256 sec
        // for up to 1/32 seconds.
        decaystarttime += 1/256;
        g.gain.linearRampToValueAtTime(
            amp * (timbre.sustain + (1 - timbre.sustain) *
                Math.exp((attacktime - decaystarttime) / decaytime)),
            decaystarttime);
      }
      // For the rest of the decay, use setTargetAtTime.
      g.gain.setTargetAtTime(amp * timbre.sustain,
          decaystarttime, decaytime);
      // Then at release time, mark the value and ramp to zero.
      g.gain.setValueAtTime(amp * (timbre.sustain + (1 - timbre.sustain) *
          Math.exp((attacktime - releasetime) / decaytime)), releasetime);
      g.gain.linearRampToValueAtTime(0, stoptime);
      g.connect(this._out);
      // Hook up a low-pass filter if cutoff is specified.
      if ((!timbre.cutoff && !timbre.cutfollow) || timbre.cutoff == Infinity) {
        f = g;
      } else {
        // Apply the cutoff frequency adjusted using cutfollow.
        f = ac.createBiquadFilter();
        f.frequency.value =
            timbre.cutoff + record.frequency * timbre.cutfollow;
        f.Q.value = timbre.resonance;
        f.connect(g);
      }
      // Hook up the main oscillator.
      o = makeOscillator(this._atop, timbre.wave, record.frequency);
      o.connect(f);
      o.start(starttime);
      o.stop(stoptime);
      // Hook up a detuned oscillator.
      if (doubled) {
        o2 = makeOscillator(
            this._atop, timbre.wave, record.frequency * timbre.detune);
        o2.connect(f);
        o2.start(starttime);
        o2.stop(stoptime);
      }
      // Store nodes in the record so that they can be modified
      // in case the tone is truncated later.
      record.gainNode = g;
      record.oscillators = [o];
      if (doubled) { record.oscillators.push(o2); }
      record.cleanuptime = stoptime;
    } else {
      // Inaudible sounds are scheduled: their purpose is to truncate
      // audible tones at the same pitch.  But duration is set to zero
      // so that they are cleaned up quickly.
      record.duration = 0;
    }
    this._startSet.push(record);
  };
  // Truncates a sound previously scheduled by _makeSound by using
  // cancelScheduledValues and directly ramping down to zero.
  // Can only be used to shorten a sound.
  Instrument.prototype._truncateSound = function(record, truncatetime) {
    if (truncatetime < record.time + record.duration) {
      record.duration = Math.max(0, truncatetime - record.time);
      if (record.gainNode) {
        var timbre = record.timbre || this._timbre,
            starttime = record.time + Instrument.timeOffset,
            releasetime = truncatetime + Instrument.timeOffset,
            attacktime = Math.min(releasetime, starttime + timbre.attack),
            decaytime = timbre.decay *
                Math.pow(440 / record.frequency, timbre.decayfollow),
            stoptime = releasetime + timbre.release,
            cleanuptime = stoptime + Instrument.cleanupDelay,
            doubled = timbre.detune && timbre.detune != 1.0,
            amp = timbre.gain * record.velocity * (doubled ? 0.5 : 1.0),
            j, g = record.gainNode;
        // Cancel any envelope points after the new releasetime.
        g.gain.cancelScheduledValues(releasetime);
        if (releasetime <= starttime) {
          // Release before start?  Totally silence the note.
          g.gain.setValueAtTime(0, releasetime);
        } else if (releasetime <= attacktime) {
          // Release before attack is done?  Interrupt ramp up.
          g.gain.linearRampToValueAtTime(
            amp * (releasetime - starttime) / (attacktime - starttime));
        } else {
          // Release during decay?  Interrupt decay down.
          g.gain.setValueAtTime(amp * (timbre.sustain + (1 - timbre.sustain) *
            Math.exp((attacktime - releasetime) / decaytime)), releasetime);
        }
        // Then ramp down to zero according to record.release.
        g.gain.linearRampToValueAtTime(0, stoptime);
        // After stoptime, stop the oscillators.  This is necessary to
        // eliminate extra work for WebAudio for no-longer-audible notes.
        if (record.oscillators) {
          for (j = 0; j < record.oscillators.length; ++j) {
            record.oscillators[j].stop(stoptime);
          }
        }
        // Schedule disconnect.
        record.cleanuptime = cleanuptime;
      }
    }
  };
  // The core scheduling loop is managed by Instrument._doPoll.  It reads
  // the audiocontext's current time and pushes tone records from one
  // stage to the next.
  //
  // 1. The first stage is the _queue, which has tones that have not
  //    yet been given to WebAudio. This loop scans _queue to find
  //    notes that need to begin in the next few seconds; then it
  //    sends those to WebAduio and moves them to _startSet. Because
  //    scheduled songs can be long, _queue can be large.
  //
  // 2. Second is _startSet, which has tones that have been given to
  //    WebAudio, but whose start times have not yet elapsed. When
  //    the time advances past the start time of a record, a 'noteon'
  //    notification is fired for the tone, and it is moved to
  //    _finishSet.
  //
  // 3. _finishSet represents the notes that are currently sounding.
  //    The programming model for Instrument is that only one tone of
  //    a specific frequency may be played at once within a Instrument,
  //    so only one tone of a given frequency may exist in _finishSet
  //    at once.  When there is a conflict, the sooner-to-end-note
  //    is truncated.
  //
  // 4. After a note is released, it may have a litle release time
  //    (depending on timbre.release), after which the nodes can
  //    be totally disconnected and cleaned up.  _cleanupSet holds
  //    notes for which we are awaiting cleanup.
  Instrument.prototype._doPoll = function() {
    this._pollTimer = null;
    this._now = null;
    if (interrupted) {
      this.silence();
      return;
    }
    // The shortest time we can delay is 1 / 1000 secs, so if an event
    // is within the next 0.5 ms, now is the closest moment, and we go
    // ahead and process it.
    var instant = this._atop.ac.currentTime + (1 / 2000),
        callbacks = [],
        j, work, when, freq, record, conflict, save, cb;
    // Schedule a batch of notes
    if (this._minQueueTime - instant <= Instrument.bufferSecs) {
      if (this._unsortedQueue) {
        this._queue.sort(function(a, b) {
          if (a.time != b.time) { return a.time - b.time; }
          if (a.duration != b.duration) { return a.duration - b.duration; }
          return a.frequency - b.frequency;
        });
        this._unsortedQueue = false;
      }
      for (j = 0; j < this._queue.length; ++j) {
        if (this._queue[j].time - instant > Instrument.bufferSecs) { break; }
      }
      if (j > 0) {
        work = this._queue.splice(0, j);
        for (j = 0; j < work.length; ++j) {
          this._makeSound(work[j]);
        }
        this._minQueueTime =
          (this._queue.length > 0) ? this._queue[0].time : Infinity;
      }
    }
    // Disconnect notes from the cleanup set.
    for (j = 0; j < this._cleanupSet.length; ++j) {
      record = this._cleanupSet[j];
      if (record.cleanuptime < instant) {
        if (record.gainNode) {
          // This explicit disconnect is needed or else Chrome's WebAudio
          // starts getting overloaded after a couple thousand notes.
          record.gainNode.disconnect();
          record.gainNode = null;
        }
        this._cleanupSet.splice(j, 1);
        j -= 1;
      }
    }
    // Notify about any notes finishing.
    for (freq in this._finishSet) {
      record = this._finishSet[freq];
      when = record.time + record.duration;
      if (when <= instant) {
        callbacks.push({
          order: [when, 0],
          f: this._trigger, t: this, a: ['noteoff', record]});
        if (record.cleanuptime != Infinity) {
          this._cleanupSet.push(record);
        }
        delete this._finishSet[freq];
      }
    }
    // Call any specific one-time callbacks that were registered.
    for (j = 0; j < this._callbackSet.length; ++j) {
      cb = this._callbackSet[j];
      when = cb.time;
      if (when <= instant) {
        callbacks.push({
          order: [when, 1],
          f: cb.callback, t: null, a: []});
        this._callbackSet.splice(j, 1);
        j -= 1;
      }
    }
    // Notify about any notes starting.
    for (j = 0; j < this._startSet.length; ++j) {
      if (this._startSet[j].time <= instant) {
        save = record = this._startSet[j];
        freq = record.frequency;
        conflict = null;
        if (this._finishSet.hasOwnProperty(freq)) {
          // If there is already a note at the same frequency playing,
          // then release the one that starts first, immediately.
          conflict = this._finishSet[freq];
          if (conflict.time < record.time || (conflict.time == record.time &&
              conflict.duration < record.duration)) {
            // Our new sound conflicts with an old one: end the old one
            // and notify immediately of its noteoff event.
            this._truncateSound(conflict, record.time);
            callbacks.push({
              order: [record.time, 0],
              f: this._trigger, t: this, a: ['noteoff', conflict]});
            delete this._finishSet[freq];
          } else {
            // A conflict from the future has already scheduled,
            // so our own note shouldn't sound.  Truncate ourselves
            // immediately, and suppress our own noteon and noteoff.
            this._truncateSound(record, conflict.time);
            conflict = record;
          }
        }
        this._startSet.splice(j, 1);
        j -= 1;
        if (record.duration > 0 && record.velocity > 0 &&
            conflict !== record) {
          this._finishSet[freq] = record;
          callbacks.push({
            order: [record.time, 2],
            f: this._trigger, t: this, a: ['noteon', record]});
        }
      }
    }
    // Schedule the next _doPoll.
    this._startPollTimer();

    // Sort callbacks according to the "order" tuple, so earlier events
    // are notified first.
    callbacks.sort(function(a, b) {
      if (a.order[0] != b.order[0]) { return a.order[0] - b.order[0]; }
      // tiebreak by notifying 'noteoff' first and 'noteon' last.
      return a.order[1] - b.order[1];
    });
    // At the end, call all the callbacks without depending on "this" state.
    for (j = 0; j < callbacks.length; ++j) {
      cb = callbacks[j];
      cb.f.apply(cb.t, cb.a);
    }
  };
  // Schedules the next _doPoll call by examining times in the various
  // sets and determining the soonest event that needs _doPoll processing.
  Instrument.prototype._startPollTimer = function(setnow) {
    // If we have already done a "setnow", then pollTimer is zero-timeout
    // and cannot be faster.
    if (this._pollTimer && this._now != null) {
      return;
    }
    var self = this,
        poll = function() { self._doPoll(); },
        earliest = Infinity, j, delay;
    if (this._pollTimer) {
      // Clear any old timer
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (setnow) {
      // When scheduling tones, cache _now and keep a zero-timeout poll.
      // _now will be cleared the next time we execute _doPoll.
      this._now = audioCurrentStartTime();
      this._pollTimer = setTimeout(poll, 0);
      return;
    }
    // Timer due to notes starting: wake up for 'noteon' notification.
    for (j = 0; j < this._startSet.length; ++j) {
      earliest = Math.min(earliest, this._startSet[j].time);
    }
    // Timer due to notes finishing: wake up for 'noteoff' notification.
    for (j in this._finishSet) {
      earliest = Math.min(
        earliest, this._finishSet[j].time + this._finishSet[j].duration);
    }
    // Timer due to scheduled callback.
    for (j = 0; j < this._callbackSet.length; ++j) {
      earliest = Math.min(earliest, this._callbackSet[j].time);
    }
    // Timer due to cleanup: add a second to give some time to batch up.
    if (this._cleanupSet.length > 0) {
      earliest = Math.min(earliest, this._cleanupSet[0].cleanuptime + 1);
    }
    // Timer due to sequencer events: subtract a little time to stay ahead.
    earliest = Math.min(
       earliest, this._minQueueTime - Instrument.dequeueTime);

    delay = Math.max(0.001, earliest - this._atop.ac.currentTime);

    // If there are no future events, then we do not need a timer.
    if (isNaN(delay) || delay == Infinity) { return; }

    // Use the Javascript timer to wake up at the right moment.
    this._pollTimer = setTimeout(poll, Math.round(delay * 1000));
  };

  // The low-level tone function.
  Instrument.prototype.tone =
  function(pitch, duration, velocity, delay, timbre, origin) {
    // If audio is not present, this is a no-op.
    if (!this._atop) { return; }

    // Called with an object instead of listed args.
    if (typeof(pitch) == 'object') {
      if (velocity == null) velocity = pitch.velocity;
      if (duration == null) duration = pitch.duration;
      if (delay == null) delay = pitch.delay;
      if (timbre == null) timbre = pitch.timbre;
      if (origin == null) origin = pitch.origin;
      pitch = pitch.pitch;
    }

    // Convert pitch from various formats to Hz frequency and a midi num.
    var midi, frequency;
    if (!pitch) { pitch = 'C'; }
    if (isNaN(pitch)) {
      midi = pitchToMidi(pitch);
      frequency = midiToFrequency(midi);
    } else {
      frequency = Number(pitch);
      if (frequency < 0) {
        midi = -frequency;
        frequency = midiToFrequency(midi);
      } else {
        midi = frequencyToMidi(frequency);
      }
    }

    if (!timbre) {
      timbre = this._timbre;
    }
    // If there is a custom timbre, validate and copy it.
    if (timbre !== this._timbre) {
      var given = timbre, key;
      timbre = {}
      for (key in defaultTimbre) {
        if (key in given) {
          timbre[key] = given[key];
        } else {
          timbre[key] = defaulTimbre[key];
        }
      }
    }

    // Create the record for a tone.
    var ac = this._atop.ac,
        now = this.now(),
        time = now + (delay || 0),
        record = {
          time: time,
          on: false,
          frequency: frequency,
          midi: midi,
          velocity: (velocity == null ? 1 : velocity),
          duration: (duration == null ? Instrument.toneLength : duration),
          timbre: timbre,
          instrument: this,
          gainNode: null,
          oscillators: null,
          cleanuptime: Infinity,
          origin: origin             // save the origin of the tone for visible feedback
        };

    if (time < now + Instrument.bufferSecs) {
      // The tone starts soon!  Give it directly to WebAudio.
      this._makeSound(record);
    } else {
      // The tone is later: queue it.
      if (!this._unsortedQueue && this._queue.length &&
          time < this._queue[this._queue.length -1].time) {
        this._unsortedQueue = true;
      }
      this._queue.push(record);
      this._minQueueTime = Math.min(this._minQueueTime, record.time);
    }
  };
  // The low-level callback scheduling method.
  Instrument.prototype.schedule = function(delay, callback) {
    this._callbackSet.push({ time: this.now() + delay, callback: callback });
  };
  // The high-level sequencing method.
  Instrument.prototype.play = function(abcstring) {
    var args = Array.prototype.slice.call(arguments),
        done = null,
        opts = {}, subfile,
        abcfile, argindex, tempo, timbre, k, delay, maxdelay = 0, attenuate,
        voicename, stems, ni, vn, j, stem, note, beatsecs, secs, v, files = [];
    // Look for continuation as last argument.
    if (args.length && 'function' == typeof(args[args.length - 1])) {
      done = args.pop();
    }
    if (!this._atop) {
      if (done) { done(); }
      return;
    }
    // Look for options as first object.
    argindex = 0;
    if ('object' == typeof(args[0])) {
      // Copy own properties into an options object.
      for (k in args[0]) if (args[0].hasOwnProperty(k)) {
        opts[k] = args[0][k];
      }
      argindex = 1;
      // If a song is supplied by options object, process it.
      if (opts.song) {
        args.push(opts.song);
      }
    }
    // Parse any number of ABC files as input.
    for (; argindex < args.length; ++argindex) {
      // Handle splitting of ABC subfiles at X: lines.
      subfile = args[argindex].split(/\n(?=X:)/);
      for (k = 0; k < subfile.length; ++k) {
        abcfile = parseABCFile(subfile[k]);
        if (!abcfile) continue;
        // Take tempo markings from the first file, and share them.
        if (!opts.tempo && abcfile.tempo) {
          opts.tempo = abcfile.tempo;
          if (abcfile.unitbeat) {
            opts.tempo *= abcfile.unitbeat / (abcfile.unitnote || 1);
          }
        }
        // Ignore files without songs.
        if (!abcfile.voice) continue;
        files.push(abcfile);
      }
    }
    // Default tempo to 120 if nothing else is specified.
    if (!opts.tempo) { opts.tempo = 120; }
    // Default volume to 1 if nothing is specified.
    if (opts.volume == null) { opts.volume = 1; }
    beatsecs = 60.0 / opts.tempo;
    // Schedule all notes from all the files.
    for (k = 0; k < files.length; ++k) {
      abcfile = files[k];
      // Each file can have multiple voices (e.g., left and right hands)
      for (vn in abcfile.voice) {
        // Each voice could have a separate timbre.
        timbre = makeTimbre(opts.timbre || abcfile.voice[vn].timbre ||
           abcfile.timbre || this._timbre, this._atop);
        // Each voice has a series of stems (notes or chords).
        stems = abcfile.voice[vn].stems;
        if (!stems) continue;
        // Starting at delay zero (now), schedule all tones.
        delay = 0;
        for (ni = 0; ni < stems.length; ++ni) {
          stem = stems[ni];
          // Attenuate chords to reduce clipping.
          attenuate = 1 / Math.sqrt(stem.notes.length);
          // Schedule every note inside a stem.
          for (j = 0; j < stem.notes.length; ++j) {
            note = stem.notes[j];
            if (note.holdover) {
              // Skip holdover notes from ties.
              continue;
            }
            secs = (note.time || stem.time) * beatsecs;
            if (stem.staccato) {
              // Shorten staccato notes.
              secs = Math.min(Math.min(secs, beatsecs / 16),
                  timbre.attack + timbre.decay);
            } else if (!note.slurred && secs >= 1/8) {
              // Separate unslurred notes by about a 30th of a second.
              secs -= 1/32;
            }
            v = (note.velocity || 1) * attenuate * opts.volume;
            // This is innsermost part of the inner loop!
            this.tone(                     // Play the tone:
              note.pitch,                  // at the given pitch
              secs,                        // for the given duration
              v,                           // with the given volume
              delay,                       // starting at the proper time
              timbre,                      // with the selected timbre
              note                         // the origin object for visual feedback
              );
          }
          delay += stem.time * beatsecs;   // Advance the sequenced time.
        }
        maxdelay = Math.max(delay, maxdelay);
      }
    }
    this._maxScheduledTime =
        Math.max(this._maxScheduledTime, this.now() + maxdelay);
    if (done) {
      // Schedule a "done" callback after all sequencing is complete.
      this.schedule(maxdelay, done);
    }
  };


  // The default sound is a square wave with a pretty quick decay to zero.
  var defaultTimbre = Instrument.defaultTimbre = {
    wave: 'square',   // Oscillator type.
    gain: 0.1,        // Overall gain at maximum attack.
    attack: 0.002,    // Attack time at the beginning of a tone.
    decay: 0.4,       // Rate of exponential decay after attack.
    decayfollow: 0,   // Amount of decay shortening for higher notes.
    sustain: 0,       // Portion of gain to sustain indefinitely.
    release: 0.1,     // Release time after a tone is done.
    cutoff: 0,        // Low-pass filter cutoff frequency.
    cutfollow: 0,     // Cutoff adjustment, a multiple of oscillator freq.
    resonance: 0,     // Low-pass filter resonance.
    detune: 0         // Detune factor for a second oscillator.
  };

  // Norrmalizes a timbre object by making a copy that has exactly
  // the right set of timbre fields, defaulting when needed.
  // A timbre can specify any of the fields of defaultTimbre; any
  // unspecified fields are treated as they are set in defaultTimbre.
  function makeTimbre(options, atop) {
    if (!options) {
      options = {};
    }
    if (typeof(options) == 'string') {
      // Abbreviation: name a wave to get a default timbre for that wave.
      options = { wave: options };
    }
    var result = {}, key,
        wt = atop && atop.wavetable && atop.wavetable[options.wave];
    for (key in defaultTimbre) {
      if (options.hasOwnProperty(key)) {
        result[key] = options[key];
      } else if (wt && wt.defs && wt.defs.hasOwnProperty(key)) {
        result[key] = wt.defs[key];
      } else{
        result[key] = defaultTimbre[key];
      }
    }
    return result;
  }

  var whiteNoiseBuf = null;
  function getWhiteNoiseBuf() {
    if (whiteNoiseBuf == null) {
      var ac = getAudioTop().ac,
          bufferSize = 2 * ac.sampleRate,
          whiteNoiseBuf = ac.createBuffer(1, bufferSize, ac.sampleRate),
          output = whiteNoiseBuf.getChannelData(0);
      for (var i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
    }
    return whiteNoiseBuf;
  }

  // This utility function creates an oscillator at the given frequency
  // and the given wavename.  It supports lookups in a static wavetable,
  // defined right below.
  function makeOscillator(atop, wavename, freq) {
    if (wavename == 'noise') {
      var whiteNoise = atop.ac.createBufferSource();
      whiteNoise.buffer = getWhiteNoiseBuf();
      whiteNoise.loop = true;
      return whiteNoise;
    }
    var wavetable = atop.wavetable, o = atop.ac.createOscillator(),
        k, pwave, bwf, wf;
    try {
      if (wavetable.hasOwnProperty(wavename)) {
        // Use a customized wavetable.
        pwave = wavetable[wavename].wave;
        if (wavetable[wavename].freq) {
          bwf = 0;
          // Look for a higher-frequency variant.
          for (k in wavetable[wavename].freq) {
            wf = Number(k);
            if (freq > wf && wf > bwf) {
              bwf = wf;
              pwave = wavetable[wavename].freq[bwf];
            }
          }
        }
        if (!o.setPeriodicWave && o.setWaveTable) {
          // The old API name: Safari 7 still uses this.
          o.setWaveTable(pwave);
        } else {
          // The new API name.
          o.setPeriodicWave(pwave);
        }
      } else {
        o.type = wavename;
      }
    } catch(e) {
      if (window.console) { window.console.log(e); }
      // If unrecognized, just use square.
      // TODO: support "noise" or other wave shapes.
      o.type = 'square';
    }
    o.frequency.value = freq;
    return o;
  }

  // Accepts either an ABC pitch or a midi number and converts to midi.
  Instrument.pitchToMidi = function(n) {
    if (typeof(n) == 'string') { return pitchToMidi(n); }
    return n;
  }

  // Accepts either an ABC pitch or a midi number and converts to ABC pitch.
  Instrument.midiToPitch = function(n) {
    if (typeof(n) == 'number') { return midiToPitch(n); }
    return n;
  }

  return Instrument;
})();

// Parses an ABC file to an object with the following structure:
// {
//   X: value from the X: lines in header (\n separated for multiple values)
//   V: value from the V:myname lines that appear before K:
//   (etc): for all the one-letter header-names.
//   K: value from the K: lines in header.
//   tempo: Q: line parsed as beatsecs
//   timbre: ... I:timbre line as parsed by makeTimbre
//   voice: {
//     myname: { // voice with id "myname"
//       V: value from the V:myname lines (from the body)
//       stems: [...] as parsed by parseABCstems
//    }
//  }
// }
// ABC files are idiosyncratic to parse: the written specifications
// do not necessarily reflect the defacto standard implemented by
// ABC content on the web.  This implementation is designed to be
// practical, working on content as it appears on the web, and only
// using the written standard as a guideline.
var ABCheader = /^([A-Za-z]):\s*(.*)$/;
var ABCtoken = /(?:\[[A-Za-z]:[^\]]*\])|\s+|%[^\n]*|![^\s!:|\[\]]*!|\+[^+|!]*\+|[_<>@^]?"[^"]*"|\[|\]|>+|<+|(?:(?:\^+|_+|=|)[A-Ga-g](?:,+|'+|))|\(\d+(?::\d+){0,2}|\d*\/\d+|\d+\/?|\/+|[xzXZ]|\[?\|\]?|:?\|:?|::|./g;
function parseABCFile(str) {
  var lines = str.split('\n'),
      result = {},
      context = result, timbre,
      j, k, header, stems, key = {}, accent = { slurred: 0 }, voiceid, out;
  // ABC files are parsed one line at a time.
  for (j = 0; j < lines.length; ++j) {
    // First, check to see if the line is a header line.
    header = ABCheader.exec(lines[j]);
    if (header) {
      handleInformation(header[1], header[2].trim());
    } else if (/^\s*(?:%.*)?$/.test(lines[j])) {
      // Skip blank and comment lines.
      continue;
    } else {
      // Parse the notes.
      parseABCNotes(lines[j]);
    }
  }
  var infer = ['unitnote', 'unitbeat', 'tempo'];
  if (result.voice) {
    out = [];
    for (j in result.voice) {
      if (result.voice[j].stems && result.voice[j].stems.length) {
        // Calculate times for all the tied notes.  This happens at the end
        // because in principle, the first note of a song could be tied all
        // the way through to the last note.
        processTies(result.voice[j].stems);
        // Bring up inferred tempo values from voices if not specified
        // in the header.
        for (k = 0; k < infer.length; ++k) {
          if (!(infer[k] in result) && (infer[k] in result.voice[j])) {
            result[infer[k]] = result.voice[j][infer[k]];
          }
        }
        // Remove this internal state variable;
        delete result.voice[j].accent;
      } else {
        out.push(j);
      }
    }
    // Delete any voices that had no stems.
    for (j = 0; j < out.length; ++j) {
      delete result.voice[out[j]];
    }
  }
  return result;


  ////////////////////////////////////////////////////////////////////////
  // Parsing helper functions below.
  ////////////////////////////////////////////////////////////////////////


  // Processes header fields such as V: voice, which may appear at the
  // top of the ABC file, or in the ABC body in a [V:voice] directive.
  function handleInformation(field, value) {
    // The following headers are recognized and processed.
    switch(field) {
      case 'V':
        // A V: header switches voices if in the body.
        // If in the header, then it is just advisory.
        if (context !== result) {
          startVoiceContext(value.split(' ')[0]);
        }
        break;
      case 'M':
        parseMeter(value, context);
        break;
      case 'L':
        parseUnitNote(value, context);
        break;
      case 'Q':
        parseTempo(value, context);
        break;
    }
    // All headers (including unrecognized ones) are
    // just accumulated as properties. Repeated header
    // lines are accumulated as multiline properties.
    if (context.hasOwnProperty(field)) {
      context[field] += '\n' + value;
    } else {
      context[field] = value;
    }
    // The K header is special: it should be the last one
    // before the voices and notes begin.
    if (field == 'K') {
      key = keysig(value);
      if (context === result) {
        startVoiceContext(firstVoiceName());
      }
    }
  }

  // Shifts context to a voice with the given id given.  If no id
  // given, then just sticks with the current voice.  If the current
  // voice is unnamed and empty, renames the current voice.
  function startVoiceContext(id) {
    id = id || '';
    if (!id && context !== result) {
      return;
    }
    if (!result.voice) {
      result.voice = {};
    }
    if (result.voice.hasOwnProperty(id)) {
      // Resume a named voice.
      context = result.voice[id];
      accent = context.accent;
    } else {
      // Start a new voice.
      context = { id: id, accent: { slurred: 0 } };
      result.voice[id] = context;
      accent = context.accent;
    }
  }

  // For picking a default voice, looks for the first voice name.
  function firstVoiceName() {
    if (result.V) {
      return result.V.split(/\s+/)[0];
    } else {
      return '';
    }
  }

  // Parses a single line of ABC notes (i.e., not a header line).
  //
  // We process an ABC song stream by dividing it into tokens, each of
  // which is a pitch, duration, or special decoration symbol; then
  // we process each decoration individually, and we process each
  // stem as a group using parseStem.
  // The structure of a single ABC note is something like this:
  //
  // NOTE -> STACCATO? PITCH DURATION? TIE?
  //
  // I.e., it always has a pitch, and it is prefixed by some optional
  // decorations such as a (.) staccato marking, and it is suffixed by
  // an optional duration and an optional tie (-) marking.
  //
  // A stem is either a note or a bracketed series of notes, followed
  // by duration and tie.
  //
  // STEM -> NOTE   OR    '[' NOTE * ']' DURAITON? TIE?
  //
  // Then a song is just a sequence of stems interleaved with other
  // decorations such as dynamics markings and measure delimiters.
  function parseABCNotes(str) {
    var tokens = str.match(ABCtoken), parsed = null,
        index = 0, dotted = 0, beatlet = null, t;
    if (!tokens) {
      return null;
    }
    while (index < tokens.length) {
      // Ignore %comments and !markings!
      if (/^[\s%]/.test(tokens[index])) { index++; continue; }
      // Handle inline [X:...] information fields
      if (/^\[[A-Za-z]:[^\]]*\]$/.test(tokens[index])) {
        handleInformation(
          tokens[index].substring(1, 2),
          tokens[index].substring(3, tokens[index].length - 1).trim()
        );
        index++;
        continue;
      }
      // Handled dotted notation abbreviations.
      if (/</.test(tokens[index])) {
        dotted = -tokens[index++].length;
        continue;
      }
      if (/>/.test(tokens[index])) {
        dotted = tokens[index++].length;
        continue;
      }
      if (/^\(\d+(?::\d+)*/.test(tokens[index])) {
        beatlet = parseBeatlet(tokens[index++]);
        continue;
      }
      if (/^[!+].*[!+]$/.test(tokens[index])) {
        parseDecoration(tokens[index++], accent);
        continue;
      }
      if (/^.?".*"$/.test(tokens[index])) {
        // Ignore double-quoted tokens (chords and general text annotations).
        index++;
        continue;
      }
      if (/^[()]$/.test(tokens[index])) {
        if (tokens[index++] == '(') {
          accent.slurred += 1;
        } else {
          accent.slurred -= 1;
          if (accent.slurred <= 0) {
            accent.slurred = 0;
            if (context.stems && context.stems.length >= 1) {
              // The last notes in a slur are not slurred.
              slurStem(context.stems[context.stems.length - 1], false);
            }
          }
        }
        continue;
      }
      // Handle measure markings by clearing accidentals.
      if (/\|/.test(tokens[index])) {
        for (t in accent) {
          if (t.length == 1) {
            // Single-letter accent properties are note accidentals.
            delete accent[t];
          }
        }
        index++;
        continue;
      }
      parsed = parseStem(tokens, index, key, accent);
      // Skip unparsable bits
      if (parsed === null) {
        index++;
        continue;
      }
      // Process a parsed stem.
      if (beatlet) {
        scaleStem(parsed.stem, beatlet.time);
        beatlet.count -= 1;
        if (!beatlet.count) {
          beatlet = null;
        }
      }
      // If syncopated with > or < notation, shift part of a beat
      // between this stem and the previous one.
      if (dotted && context.stems && context.stems.length) {
        if (dotted > 0) {
          t = (1 - Math.pow(0.5, dotted)) * parsed.stem.time;
        } else {
          t = (Math.pow(0.5, -dotted) - 1) *
              context.stems[context.stems.length - 1].time;
        }
        syncopateStem(context.stems[context.stems.length - 1], t);
        syncopateStem(parsed.stem, -t);
      }
      dotted = 0;
      // Slur all the notes contained within a strem.
      if (accent.slurred) {
        slurStem(parsed.stem, true);
      }
      // Start a default voice if we're not in a voice yet.
      if (context === result) {
        startVoiceContext(firstVoiceName());
      }
      if (!('stems' in context)) { context.stems = []; }
      // Add the stem to the sequence of stems for this voice.
      context.stems.push(parsed.stem);
      // Advance the parsing index since a stem is multiple tokens.
      index = parsed.index;
    }
  }

  // Parse M: lines.  "3/4" is 3/4 time and "C" is 4/4 (common) time.
  function parseMeter(mline, beatinfo) {
    var d = /^C/.test(mline) ? 4/4 : durationToTime(mline);
    if (!d) { return; }
    if (!beatinfo.unitnote) {
      if (d < 0.75) {
        beatinfo.unitnote = 1/16;
      } else {
        beatinfo.unitnote = 1/8;
      }
    }
  }
  // Parse L: lines, e.g., "1/8".
  function parseUnitNote(lline, beatinfo) {
    var d = durationToTime(lline);
    if (!d) { return; }
    beatinfo.unitnote = d;
  }
  // Parse Q: line, e.g., "1/4=66".
  function parseTempo(qline, beatinfo) {
    var parts = qline.split(/\s+|=/), j, unit = null, tempo = null;
    for (j = 0; j < parts.length; ++j) {
      // It could be reversed, like "66=1/4", or just "120", so
      // determine what is going on by looking for a slash etc.
      if (parts[j].indexOf('/') >= 0 || /^[1-4]$/.test(parts[j])) {
        // The note-unit (e.g., 1/4).
        unit = unit || durationToTime(parts[j]);
      } else {
        // The tempo-number (e.g., 120)
        tempo = tempo || Number(parts[j]);
      }
    }
    if (unit) {
      beatinfo.unitbeat = unit;
    }
    if (tempo) {
      beatinfo.tempo = tempo;
    }
  }
  // Run through all the notes, adding up time for tied notes,
  // and marking notes that were held over with holdover = true.
  function processTies(stems) {
    var tied = {}, nextTied, j, k, note, firstNote;
    for (j = 0; j < stems.length; ++j) {
      nextTied = {};
      for (k = 0; k < stems[j].notes.length; ++k) {
        firstNote = note = stems[j].notes[k];
        if (tied.hasOwnProperty(note.pitch)) {  // Pitch was tied from before.
          firstNote = tied[note.pitch];   // Get the earliest note in the tie.
          firstNote.time += note.time;    // Extend its time.
          note.holdover = true;           // Silence this note as a holdover.
        }
        if (note.tie) {                   // This note is tied with the next.
          nextTied[note.pitch] = firstNote;  // Save it away.
        }
      }
      tied = nextTied;
    }
  }
  // Returns a map of A-G -> accidentals, according to the key signature.
  // When n is zero, there are no accidentals (e.g., C major or A minor).
  // When n is positive, there are n sharps (e.g., for G major, n = 1).
  // When n is negative, there are -n flats (e.g., for F major, n = -1).
  function accidentals(n) {
    var sharps = 'FCGDAEB',
        result = {}, j;
    if (!n) {
      return result;
    }
    if (n > 0) {  // Handle sharps.
      for (j = 0; j < n && j < 7; ++j) {
        result[sharps.charAt(j)] = '^';
      }
    } else {  // Flats are in the opposite order.
      for (j = 0; j > n && j > -7; --j) {
        result[sharps.charAt(6 + j)] = '_';
      }
    }
    return result;
  }
  // Decodes the key signature line (e.g., K: C#m) at the front of an ABC tune.
  // Supports the whole range of scale systems listed in the ABC spec.
  function keysig(keyname) {
    if (!keyname) { return {}; }
    var kkey, sigcodes = {
      // Major
      'c#':7, 'f#':6, 'b':5, 'e':4, 'a':3, 'd':2, 'g':1, 'c':0,
      'f':-1, 'bb':-2, 'eb':-3, 'ab':-4, 'db':-5, 'gb':-6, 'cb':-7,
      // Minor
      'a#m':7, 'd#m':6, 'g#m':5, 'c#m':4, 'f#m':3, 'bm':2, 'em':1, 'am':0,
      'dm':-1, 'gm':-2, 'cm':-3, 'fm':-4, 'bbm':-5, 'ebm':-6, 'abm':-7,
      // Mixolydian
      'g#mix':7, 'c#mix':6, 'f#mix':5, 'bmix':4, 'emix':3,
      'amix':2, 'dmix':1, 'gmix':0, 'cmix':-1, 'fmix':-2,
      'bbmix':-3, 'ebmix':-4, 'abmix':-5, 'dbmix':-6, 'gbmix':-7,
      // Dorian
      'd#dor':7, 'g#dor':6, 'c#dor':5, 'f#dor':4, 'bdor':3,
      'edor':2, 'ador':1, 'ddor':0, 'gdor':-1, 'cdor':-2,
      'fdor':-3, 'bbdor':-4, 'ebdor':-5, 'abdor':-6, 'dbdor':-7,
      // Phrygian
      'e#phr':7, 'a#phr':6, 'd#phr':5, 'g#phr':4, 'c#phr':3,
      'f#phr':2, 'bphr':1, 'ephr':0, 'aphr':-1, 'dphr':-2,
      'gphr':-3, 'cphr':-4, 'fphr':-5, 'bbphr':-6, 'ebphr':-7,
      // Lydian
      'f#lyd':7, 'blyd':6, 'elyd':5, 'alyd':4, 'dlyd':3,
      'glyd':2, 'clyd':1, 'flyd':0, 'bblyd':-1, 'eblyd':-2,
      'ablyd':-3, 'dblyd':-4, 'gblyd':-5, 'cblyd':-6, 'fblyd':-7,
      // Locrian
      'b#loc':7, 'e#loc':6, 'a#loc':5, 'd#loc':4, 'g#loc':3,
      'c#loc':2, 'f#loc':1, 'bloc':0, 'eloc':-1, 'aloc':-2,
      'dloc':-3, 'gloc':-4, 'cloc':-5, 'floc':-6, 'bbloc':-7
    };
    var k = keyname.replace(/\s+/g, '').toLowerCase().substr(0, 5);
    var scale = k.match(/maj|min|mix|dor|phr|lyd|loc|m/);
    if (scale) {
      if (scale == 'maj') {
        kkey = k.substr(0, scale.index);
      } else if (scale == 'min') {
        kkey = k.substr(0, scale.index + 1);
      } else {
        kkey = k.substr(0, scale.index + scale[0].length);
      }
    } else {
      kkey = /^[a-g][#b]?/.exec(k) || '';
    }
    var result = accidentals(sigcodes[kkey]);
    var extras = keyname.substr(kkey.length).match(/(_+|=|\^+)[a-g]/ig);
    if (extras) {
      for (var j = 0; j < extras.length; ++j) {
        var note = extras[j].charAt(extras[j].length - 1).toUpperCase();
        if (extras[j].charAt(0) == '=') {
          delete result[note];
        } else {
          result[note] = extras[j].substr(0, extras[j].length - 1);
        }
      }
    }
    return result;
  }
  // Additively adjusts the beats for a stem and the contained notes.
  function syncopateStem(stem, t) {
    var j, note, stemtime = stem.time, newtime = stemtime + t;
    stem.time = newtime;
    syncopateStem
    for (j = 0; j < stem.notes.length; ++j) {
      note = stem.notes[j];
      // Only adjust a note's duration if it matched the stem's duration.
      if (note.time == stemtime) { note.time = newtime; }
    }
  }
  // Marks everything in the stem with the slur attribute (or deletes it).
  function slurStem(stem, addSlur) {
    var j, note;
    for (j = 0; j < stem.notes.length; ++j) {
      note = stem.notes[j];
      if (addSlur) {
        note.slurred = true;
      } else if (note.slurred) {
        delete note.slurred;
      }
    }
  }
  // Scales the beats for a stem and the contained notes.
  function scaleStem(stem, s) {
    var j;
    stem.time *= s;
    for (j = 0; j < stem.notes.length; ++j) {
      stem.notes[j].time *= s;;
    }
  }
  // Parses notation of the form (3 or (5:2:10, which means to do
  // the following 3 notes in the space of 2 notes, or to do the following
  // 10 notes at the rate of 5 notes per 2 beats.
  function parseBeatlet(token) {
    var m = /^\((\d+)(?::(\d+)(?::(\d+))?)?$/.exec(token);
    if (!m) { return null; }
    var count = Number(m[1]),
        beats = Number(m[2]) || 2,
        duration = Number(m[3]) || count;
    return {
      time: beats / count,
      count: duration
    };
  }
  // Parse !ppp! markings.
  function parseDecoration(token, accent) {
    if (token.length < 2) { return; }
    token = token.substring(1, token.length - 1);
    switch (token) {
      case 'pppp': case 'ppp':
        accent.dynamics = 0.2; break;
      case 'pp':
        accent.dynamics = 0.4; break;
      case 'p':
        accent.dynamics = 0.6; break;
      case 'mp':
        accent.dynamics = 0.8; break;
      case 'mf':
        accent.dynamics = 1.0; break;
      case 'f':
        accent.dynamics = 1.2; break;
      case 'ff':
        accent.dynamics = 1.4; break;
      case 'fff': case 'ffff':
        accent.dynamics = 1.5; break;
    }
  }
  // Parses a stem, which may be a single note, or which may be
  // a chorded note.
  function parseStem(tokens, index, key, accent) {
    var notes = [],
        duration = '', staccato = false,
        noteDuration, noteTime, velocity,
        lastNote = null, minStemTime = Infinity, j;
    // A single staccato marking applies to the entire stem.
    if (index < tokens.length && '.' == tokens[index]) {
      staccato = true;
      index++;
    }
    if (index < tokens.length && tokens[index] == '[') {
      // Deal with [CEG] chorded notation.
      index++;
      // Scan notes within the chord.
      while (index < tokens.length) {
        // Ignore and space and %comments.
        if (/^[\s%]/.test(tokens[index])) {
          index++;
          continue;
        }
        if (/[A-Ga-g]/.test(tokens[index])) {
          // Grab a pitch.
          lastNote = {
            pitch: applyAccent(tokens[index++], key, accent),
            tie: false
          }
          lastNote.frequency = pitchToFrequency(lastNote.pitch);
          notes.push(lastNote);
        } else if (/[xzXZ]/.test(tokens[index])) {
          // Grab a rest.
          lastNote = null;
          index++;
        } else if ('.' == tokens[index]) {
          // A staccato mark applies to the entire stem.
          staccato = true;
          index++;
          continue;
        } else {
          // Stop parsing the stem if something is unrecognized.
          break;
        }
        // After a pitch or rest, look for a duration.
        if (index < tokens.length &&
            /^(?![\s%!]).*[\d\/]/.test(tokens[index])) {
          noteDuration = tokens[index++];
          noteTime = durationToTime(noteDuration);
        } else {
          noteDuration = '';
          noteTime = 1;
        }
        // If it's a note (not a rest), store the duration
        if (lastNote) {
          lastNote.duration = noteDuration;
          lastNote.time = noteTime;
        }
        // When a stem has more than one duration, use the shortest
        // one for timing. The standard says to pick the first one,
        // but in practice, transcribed music online seems to
        // follow the rule that the stem's duration is determined
        // by the shortest contained duration.
        if (noteTime && noteTime < minStemTime) {
          duration = noteDuration;
          minStemTime = noteTime;
        }
        // After a duration, look for a tie mark.  Individual notes
        // within a stem can be tied.
        if (index < tokens.length && '-' == tokens[index]) {
          if (lastNote) {
            notes[notes.length - 1].tie = true;
          }
          index++;
        }
      }
      // The last thing in a chord should be a ].  If it isn't, then
      // this doesn't look like a stem after all, and return null.
      if (tokens[index] != ']') {
        return null;
      }
      index++;
    } else if (index < tokens.length && /[A-Ga-g]/.test(tokens[index])) {
      // Grab a single note.
      lastNote = {
        pitch: applyAccent(tokens[index++], key, accent),
        tie: false,
        duration: '',
        time: 1
      }
      lastNote.frequency = pitchToFrequency(lastNote.pitch);
      notes.push(lastNote);
    } else if (index < tokens.length && /^[xzXZ]$/.test(tokens[index])) {
      // Grab a rest - no pitch.
      index++;
    } else {
      // Something we don't recognize - not a stem.
      return null;
    }
    // Right after a [chord], note, or rest, look for a duration marking.
    if (index < tokens.length && /^(?![\s%!]).*[\d\/]/.test(tokens[index])) {
      duration = tokens[index++];
      noteTime = durationToTime(duration);
      // Apply the duration to all the ntoes in the stem.
      // NOTE: spec suggests multiplying this duration, but that
      // idiom is not seen (so far) in practice.
      for (j = 0; j < notes.length; ++j) {
        notes[j].duration = duration;
        notes[j].time = noteTime;
      }
    }
    // Then look for a trailing tie marking.  Will tie every note in a chord.
    if (index < tokens.length && '-' == tokens[index]) {
      index++;
      for (j = 0; j < notes.length; ++j) {
        notes[j].tie = true;
      }
    }
    if (accent.dynamics) {
      velocity = accent.dynamics;
      for (j = 0; j < notes.length; ++j) {
        notes[j].velocity = velocity;
      }
    }
    return {
      index: index,
      stem: {
        notes: notes,
        duration: duration,
        staccato: staccato,
        time: durationToTime(duration)
      }
    };
  }
  // Normalizes pitch markings by stripping leading = if present.
  function stripNatural(pitch) {
    if (pitch.length > 0 && pitch.charAt(0) == '=') {
      return pitch.substr(1);
    }
    return pitch;
  }
  // Processes an accented pitch, automatically applying accidentals
  // that have accumulated within the measure, and also saving
  // explicit accidentals to continue to apply in the measure.
  function applyAccent(pitch, key, accent) {
    var m = /^(\^+|_+|=|)([A-Ga-g])(.*)$/.exec(pitch), letter;
    if (!m) { return pitch; }
    // Note that an accidental in one octave applies in other octaves.
    letter = m[2].toUpperCase();
    if (m[1].length > 0) {
      // When there is an explicit accidental, then remember it for
      // the rest of the measure.
      accent[letter] = m[1];
      return stripNatural(pitch);
    }
    if (accent.hasOwnProperty(letter)) {
      // Accidentals from this measure apply to unaccented notes.
      return stripNatural(accent[letter] + m[2] + m[3]);
    }
    if (key.hasOwnProperty(letter)) {
      // Key signatures apply by default.
      return stripNatural(key[letter] + m[2] + m[3]);
    }
    return stripNatural(pitch);
  }
  // Converts an ABC duration to a number (e.g., "/3"->0.333 or "11/2"->1.5).
  function durationToTime(duration) {
    var m = /^(\d*)(?:\/(\d*))?$|^(\/+)$/.exec(duration), n, d, i = 0, ilen;
    if (!m) return;
    if (m[3]) return Math.pow(0.5, m[3].length);
    d = (m[2] ? parseFloat(m[2]) : /\//.test(duration) ? 2 : 1);
    // Handle mixed frations:
    ilen = 0;
    n = (m[1] ? parseFloat(m[1]) : 1);
    if (m[2]) {
      while (ilen + 1 < m[1].length && n > d) {
        ilen += 1
        i = parseFloat(m[1].substring(0, ilen))
        n = parseFloat(m[1].substring(ilen))
      }
    }
    return i + (n / d);
  }
}

// wavetable is a table of names for nonstandard waveforms.
// The table maps names to objects that have wave: and freq:
// properties. The wave: property is a PeriodicWave to use
// for the oscillator.  The freq: property, if present,
// is a map from higher frequencies to more PeriodicWave
// objects; when a frequency higher than the given threshold
// is requested, the alternate PeriodicWave is used.
function makeWavetable(ac) {
  return (function(wavedata) {
    function makePeriodicWave(data) {
      var n = data.real.length,
          real = new Float32Array(n),
          imag = new Float32Array(n),
          j;
      for (j = 0; j < n; ++j) {
        real[j] = data.real[j];
        imag[j] = data.imag[j];
      }
      try {
        // Latest API naming.
        return ac.createPeriodicWave(real, imag);
      } catch (e) { }
      try {
        // Earlier API naming.
        return ac.createWaveTable(real, imag);
      } catch (e) { }
      return null;
    }
    function makeMultiple(data, mult, amt) {
      var result = { real: [], imag: [] }, j, n = data.real.length, m;
      for (j = 0; j < n; ++j) {
        m = Math.log(mult[Math.min(j, mult.length - 1)]);
        result.real.push(data.real[j] * Math.exp(amt * m));
        result.imag.push(data.imag[j] * Math.exp(amt * m));
      }
      return result;
    }
    var result = {}, k, d, n, j, ff, record, wave, pw;
    for (k in wavedata) {
      d = wavedata[k];
      wave = makePeriodicWave(d);
      if (!wave) { continue; }
      record = { wave: wave };
      // A strategy for computing higher frequency waveforms: apply
      // multipliers to each harmonic according to d.mult.  These
      // multipliers can be interpolated and applied at any number
      // of transition frequencies.
      if (d.mult) {
        ff = wavedata[k].freq;
        record.freq = {};
        for (j = 0; j < ff.length; ++j) {
          wave =
            makePeriodicWave(makeMultiple(d, d.mult, (j + 1) / ff.length));
          if (wave) { record.freq[ff[j]] = wave; }
        }
      }
      // This wave has some default filter settings.
      if (d.defs) {
        record.defs = d.defs;
      }
      result[k] = record;
    }
    return result;
  })({
    // Currently the only nonstandard waveform is "piano".
    // It is based on the first 32 harmonics from the example:
    // https://github.com/GoogleChrome/web-audio-samples
    // /blob/gh-pages/samples/audio/wave-tables/Piano
    // That is a terrific sound for the lowest piano tones.
    // For higher tones, interpolate to a customzed wave
    // shape created by hand, and apply a lowpass filter.
    piano: {
      real: [0, 0, -0.203569, 0.5, -0.401676, 0.137128, -0.104117, 0.115965,
             -0.004413, 0.067884, -0.00888, 0.0793, -0.038756, 0.011882,
             -0.030883, 0.027608, -0.013429, 0.00393, -0.014029, 0.00972,
             -0.007653, 0.007866, -0.032029, 0.046127, -0.024155, 0.023095,
             -0.005522, 0.004511, -0.003593, 0.011248, -0.004919, 0.008505],
      imag: [0, 0.147621, 0, 0.000007, -0.00001, 0.000005, -0.000006, 0.000009,
             0, 0.000008, -0.000001, 0.000014, -0.000008, 0.000003,
             -0.000009, 0.000009, -0.000005, 0.000002, -0.000007, 0.000005,
             -0.000005, 0.000005, -0.000023, 0.000037, -0.000021, 0.000022,
             -0.000006, 0.000005, -0.000004, 0.000014, -0.000007, 0.000012],
      // How to adjust the harmonics for the higest notes.
      mult: [1, 1, 0.18, 0.016, 0.01, 0.01, 0.01, 0.004,
                0.014, 0.02, 0.014, 0.004, 0.002, 0.00001],
      // The frequencies at which to interpolate the harmonics.
      freq: [65, 80, 100, 135, 180, 240, 620, 1360],
      // The default filter settings to use for the piano wave.
      // TODO: this approach attenuates low notes too much -
      // this should be fixed.
      defs: { wave: 'piano', gain: 0.5,
              attack: 0.002, decay: 0.25, sustain: 0.03, release: 0.1,
              decayfollow: 0.7,
              cutoff: 800, cutfollow: 0.1, resonance: 1, detune: 0.9994 }
    }
  });
}
// The package implementation. Right now, just one class.
var impl = {
  Instrument: Instrument,
  parseABCFile: parseABCFile
};

if (module && module.exports) {
  // Nodejs usage: export the impl object as the package.
  module.exports = impl;
} else if (define && define.amd) {
  // Requirejs usage: define the impl object as the package.
  define(function() { return impl; });
} else {
  // Plain script tag usage: stick Instrument on the window object.
  for (var exp in impl) {
    global[exp] = impl[exp];
  }
}

})(
  this,                                     // global (window) object
  (typeof module) == 'object' && module,    // present in node.js
  (typeof define) == 'function' && define   // present with an AMD loader
);

(function(){
    'use strict';
    
    /** a Rubik's cube made with WebGL
     *
     * @link https://github.com/blonkm/rubiks-cube
     * @authors 
     *      Tiffany Wang - https://github.com/tinnywang
     *      Michiel van der Blonk - blonkm@gmail.com
     * @license LGPL
     */
    var GLube = function() { 
    var canvas;
    var gl;
    var rubiksCube;
    var shaderProgram;

    var rightMouseDown = false;
    var x_init_right;
    var y_init_right;
    var x_new_right;
    var y_new_right;
    var leftMouseDown = false;
    var init_coordinates;
    var new_coordinates;
    var isRotating = false;
    var isAnimating = false;
    var isInitializing = true;
    var eye = [0, 0, -17];
    var center = [0, 0, 0];
    var up = [0, 1, 0];
    var fov = -19.5;

    var modelViewMatrix = mat4.create();
    var projectionMatrix = mat4.create();
    var rotationMatrix = mat4.create();

    var DEGREES = 6;
    var MARGIN_OF_ERROR = 1e-3;
    var X_AXIS = 0;
    var Y_AXIS = 1;
    var Z_AXIS = 2;
    var LEFT_MOUSE = 0;
    var RIGHT_MOUSE = 2;
    var CANVAS_X_OFFSET = 0;
    var CANVAS_Y_OFFSET = 0;

    function RubiksCube() {
        this.selectedCubes = [];// an instance of Cube
        this.rotatedCubes = null; // an array of Cubes
        this.rotationAxis = null; // a vec3
        this.axisConstant = null; // X_AXIS, Y_AXIS, or Z_AXIS
        this.rotationAngle = 0;
        this.degrees = DEGREES;
        this.cubeVerticesBuffer = null;
        this.cubeNormalsBuffer = null;
        this.cubeFacesBuffer = null;
        this.stickerVerticesBuffer = null;
        this.stickerNormalsBuffer = null;
        this.stickerFacesBuffer = null;
        this.pickingFramebuffer = null;
        this.pickingTexture = null;
        this.pickingRenderBuffer = null;
        this.normalsCube = new NormalsCube();
        this.cubes = new Array(3);
        this.noMove = {face:'', count:0, inverse:false};
        this.currentMove = {face:'', count:0, inverse:false};

        this.init = function() {
            this.initTextureFramebuffer();
            this.initCubeBuffers();
            this.initStickerBuffers();
            for (var r = 0; r < 3; r++) {
                this.cubes[r] = new Array(3);
                for (var g = 0; g < 3; g++) {
                    this.cubes[r][g] = new Array(3);
                    for (var b = 0; b < 3; b++) {
                        var coordinates = [r - 1, g - 1, b - 1];
                        var color = [r / 3, g / 3, b / 3, 1.0];
                        this.cubes[r][g][b] = new Cube(this, coordinates, color);
                    }
                }
            }
            this.initCenters();
        }

        this.initTextureFramebuffer = function() {
            this.pickingFramebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickingFramebuffer);

            this.pickingTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.pickingTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

            this.pickingRenderBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickingRenderBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, canvas.width, canvas.height);

            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickingTexture, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickingRenderBuffer);
        }

        this.initCubeBuffers = function() {
            // vertices
            this.cubeVerticesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVerticesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cubeModel.vertices), gl.STATIC_DRAW);
            // normals
            this.cubeNormalsBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeNormalsBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cubeModel.normals), gl.STATIC_DRAW);
            // faces
            this.cubeFacesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cubeFacesBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(cubeModel.faces), gl.STATIC_DRAW);
        }

        this.initStickerBuffers = function() {
            // vertices
            this.stickerVerticesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.stickerVerticesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(stickerModel.vertices), gl.STATIC_DRAW);
            // normals
            this.stickerNormalsBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.stickerNormalsBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(stickerModel.normals), gl.STATIC_DRAW);
            // faces
            this.stickerFacesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.stickerFacesBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(stickerModel.faces), gl.STATIC_DRAW);
        }


        this.initCenters = function() {
            this.centerCubes = {
                left:   this.cubes[1][1][2],
                right:  this.cubes[1][1][0],
                up:     this.cubes[1][0][1],
                down:   this.cubes[1][2][1],
                front:  this.cubes[0][1][1],
                back:   this.cubes[2][1][1],
                core:   this.cubes[1][1][1]
            }
        }

        this.init();

        this.draw = function() {
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            mat4.perspective(projectionMatrix, fov, canvas.width / canvas.height, 0.1, 100.0);
            mat4.identity(modelViewMatrix);
            mat4.lookAt(modelViewMatrix, eye, center, up);
            mat4.multiply(modelViewMatrix, modelViewMatrix, rotationMatrix);
            var mvMatrix = mat4.create();
            for (var r = 0; r < 3; r++) {
                for (var g = 0; g < 3; g++) {
                    for (var b = 0; b < 3; b++) {
                        var cube = this.cubes[r][g][b];
                        cube.draw(cubeModel.ambient);
                        for (var s in cube.stickers) {
                            cube.stickers[s].draw();
                        }
                    }
                }
            }
        }

        this.drawToPickingFramebuffer = function() {
            gl.bindFramebuffer(gl.FRAMEBUFFER, rubiksCube.pickingFramebuffer);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.uniform1i(shaderProgram.lighting, 0);

            mat4.perspective(projectionMatrix, fov, canvas.width / canvas.height, 0.1, 100.0);
            mat4.identity(modelViewMatrix);
            mat4.lookAt(modelViewMatrix, eye, center, up);
            mat4.multiply(modelViewMatrix, modelViewMatrix, rotationMatrix);
            var mvMatrix = mat4.create();
            for (var r = 0; r < 3; r++) {
                for (var g = 0; g < 3; g++) {
                    for (var b = 0; b < 3; b++) {
                        var cube = this.cubes[r][g][b];
                        cube.draw(cube.color);
                    }
                }
            }

            gl.uniform1i(shaderProgram.lighting, 1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }

        this.drawToNormalsFramebuffer = function() {
            gl.bindFramebuffer(gl.FRAMEBUFFER, rubiksCube.normalsCube.normalsFramebuffer);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            mat4.perspective(projectionMatrix, fov, canvas.width / canvas.height, 0.1, 100.0);
            mat4.identity(modelViewMatrix);
            mat4.lookAt(modelViewMatrix, eye, center, up);
            mat4.multiply(modelViewMatrix, modelViewMatrix, rotationMatrix);
            var mvMatrix = mat4.create();
            mat4.copy(mvMatrix, modelViewMatrix);
            this.normalsCube.draw();

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }

        /*
         * Sets this.rotatedCubes to an array of cubes that share the same AXIS coordinate as this.selectedCubes.
         * AXIS is 0, 1, or 2 for the x-, y-, or z-coordinate.
         */
        this.setRotatedCubes = function(move) {
            if (!this.rotationAxis) {
                return;
            }
            var cubes = [];
            beat();
            position = (position + 1) %twinkle_beat.length;
            this.selectedCubes.forEach(function(el) {
                var value = el.coordinates[this.axisConstant];
            for (var r = 0; r < 3; r++) {
                for (var g = 0; g < 3; g++) {
                    for (var b = 0; b < 3; b++) {
                        var cube = this.cubes[r][g][b];
                        if (Math.abs(cube.coordinates[this.axisConstant] - value) < MARGIN_OF_ERROR) {
                            cubes.push(cube);
                        }
                    }
                }
            }
            }, this);
            if (cubes.length >= 9) {
                this.rotatedCubes = cubes;
                // is this a slice layer?
                var i;
                var that = this;
                cubes.forEach(function(cube, i, cubes) {
                    if (cube.stickers.length==0) {
                        var slices = ['S', 'E', 'M']; //x,y,z
                        var slice = slices[that.axisConstant];
                        var x = that.rotationAxis[X_AXIS];
                        var y = that.rotationAxis[Y_AXIS];
                        var z = that.rotationAxis[Z_AXIS];
                        var sum = x+y+z;
                        var inverse = false;
                        inverse |= slice=='M' && sum==1;
                        inverse |= slice=='E' && sum==1;
                        inverse |= slice=='S' && sum==-1; // silly cube notation
                        // update centers for slice moves
                        var m = (move===undefined) ? 1 : move.count;
                        while (m-- >0) {
                        that.updateCenters(slice, inverse);
                    }
                        
                    }
                    });
            }
        }

        /*
         * Rotates this.rotatedCubes around this.rotationAxis by this.degrees.
         */
        this.rotateLayer = function(isDouble) {
            var fullTurn = isDouble ? 180 : 90;
            if (Math.abs(this.rotationAngle) == fullTurn) {
                this.rotationAngle = 0;
                isRotating = false;
                isAnimating = false;
                this.degrees = isInitializing ? fullTurn: DEGREES;
                return;
            }

            // if (!isInitializing)
                this.degrees = 3 + DEGREES * $.easing.easeOutExpo(0, this.rotationAngle, 0, 1, fullTurn);
            if (this.rotationAngle + this.degrees > fullTurn) {
                this.degrees = fullTurn - this.rotationAngle;
                this.rotationAngle = fullTurn;
            }
            else {
                this.rotationAngle += this.degrees;
            }

            var newRotationMatrix = mat4.create();
            mat4.rotate(newRotationMatrix, newRotationMatrix, degreesToRadians(this.degrees), this.rotationAxis);

            for (var c in this.rotatedCubes) {
                var cube = this.rotatedCubes[c];
                vec3.transformMat4(cube.coordinates, cube.coordinates, newRotationMatrix);
                mat4.multiply(cube.rotationMatrix, newRotationMatrix, cube.rotationMatrix);
            }
        }

        this.colorToCube = function(rgba) {
            var r = rgba[0];
            var g = rgba[1];
            var b = rgba[2];
            if (r == 255 && g == 255 && b == 255) { // clicked outside the cube
                return null;
            } else {
                return this.cubes[r % 3][g % 3][b % 3];
            }
        }

        this.selectCube = function(x, y) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickingFramebuffer);
            var pixelValues = new Uint8Array(4);
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixelValues);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.selectedCubes.push(this.colorToCube(pixelValues));
        }

        this.setRotationAxis = function(x, y, direction) {
            var normal = this.normalsCube.getNormal(x, y);
            if (!normal) {
                return;
            }
            var axis = vec3.create();
            vec3.cross(axis, normal, direction);
            var x = Math.round(axis[0]);
            var y = Math.round(axis[1]);
            var z = Math.round(axis[2]);
            this.rotationAxis = Math.abs(x + y + z) == 1 ? [x, y, z] : null;
            if (!this.rotationAxis) {
                this.axisConstant = null;
                return;
            }
            if (x == 1 || x == -1) {
                this.axisConstant = X_AXIS;
            } else if (y == 1 || y == -1) {
                this.axisConstant = Y_AXIS;
            } else if (z == 1 || z == -1 ) {
                this.axisConstant = Z_AXIS;
            }
        }

        /*
         * For testing the rotation of a layer by matrix instead of layer.
         * Repeatedly called by doTransform to turn layer by this.degrees until 90 degrees is done
         */
        this.transform = function(r,g,b, axis, inverse) {
            var rot = [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1]
            ];
            this.selectedCubes.push(this.cubes[r][g][b]);
            this.axisConstant = axis;
            this.rotationAxis = rot[axis];
            if (inverse)
                vec3.scale(this.rotationAxis, this.rotationAxis, -1);
            this.setRotatedCubes();
            isRotating = true;
        }

        /*
         * For testing only: timed transform of the cube, rotating a layer
         */
        this.doTransform = function(params) {
            var that = this;
            var delay = 50;
            if (!isRotating) {
                var move = params.shift();
                this.transform(move.r, move.g, move.b, move.axis);
                setTimeout(function() {that.doTransform(params)}, delay);
            }
            else
                if (params.length > 0)
                    setTimeout(function() {that.doTransform(params)}, delay);
        }

        this.centerColors = {
            left:   'blue',
            right:  'green',
            up:     'yellow',
            down:   'white',
            front:  'red',
            back:   'orange',
            core:   'black'
        }

        /* rotate defined centers with a slice layer */
        this.updateCenters = function(layer, inverse) {
            var c=this.centerCubes;
            var centers = {
                'M': {
                    left:   c.left,
                    right:  c.right,
                    up:     c.back,
                    down:   c.front,
                    front:  c.up,
                    back:   c.down
                },
                'E': {
                    left:   c.back,
                    right:  c.front,
                    up:     c.up,
                    down:   c.down,
                    front:  c.left,
                    back:   c.right
                },
                'S': {
                    left:   c.down,
                    right:  c.up,
                    up:     c.left,
                    down:   c.right,
                    front:  c.front,
                    back:   c.back
                }
            };
            var centersInverse = {
                'M': {
                    left:   c.left,
                    right:  c.right,
                    up:     c.front,
                    down:   c.back,
                    front:  c.down,
                    back:   c.up
                },
                'E': {
                    left:   c.front,
                    right:  c.back,
                    up:     c.up,
                    down:   c.down,
                    front:  c.right,
                    back:   c.left
                },
                'S': {
                    left:   c.up,
                    right:  c.down,
                    up:     c.right,
                    down:   c.left,
                    front:  c.front,
                    back:   c.back
                },
            };
            if (centers[layer])
            {
                if (inverse==true)
                    this.centerCubes = centersInverse[layer];
                else
                    this.centerCubes = centers[layer];
                this.centerCubes.core = this.cubes[1][1][1];
            }
        }
        
        this.move = function(move) {
            var rot = {
                X: [1, 0, 0],
                Y: [0, 1, 0],
                Z: [0, 0, 1]
            };
            var inverse = typeof move.inverse !== 'undefined' ? move.inverse : false;
            var L = this.centerCubes.left;
            var R = this.centerCubes.right;
            var U = this.centerCubes.up;
            var D = this.centerCubes.down;
            var F = this.centerCubes.front;
            var B = this.centerCubes.back;
            var C = this.centerCubes.core;
            // beat();
            // position = (position + 1) %12;
            // is_major = !is_major;
            var layers = {
                "L": {cubies:[L], axis:Z_AXIS, rotation:rot.Z, ccw:true},
                "R": {cubies:[R], axis:Z_AXIS, rotation:rot.Z, ccw:false},

                "U": {cubies:[U], axis:Y_AXIS, rotation:rot.Y, ccw:false},
                "D": {cubies:[D], axis:Y_AXIS, rotation:rot.Y, ccw:true},

                "F": {cubies:[F], axis:X_AXIS, rotation:rot.X, ccw:false},
                "B": {cubies:[B], axis:X_AXIS, rotation:rot.X, ccw:true},

                // use center of cube for slices
                "M": {cubies:[C], axis:Z_AXIS, rotation:rot.Z, ccw:true},
                "E": {cubies:[C], axis:Y_AXIS, rotation:rot.Y, ccw:true},
                "S": {cubies:[C], axis:X_AXIS, rotation:rot.X, ccw:false},

                "l": {cubies:[L,C], axis:Z_AXIS, rotation:rot.Z, ccw:true},
                "r": {cubies:[R,C], axis:Z_AXIS, rotation:rot.Z, ccw:false},

                "u": {cubies:[U,C], axis:Y_AXIS, rotation:rot.Y, ccw:false},
                "d": {cubies:[D,C], axis:Y_AXIS, rotation:rot.Y, ccw:true},

                "f": {cubies:[F,C], axis:X_AXIS, rotation:rot.X, ccw:false},
                "b": {cubies:[B,C], axis:X_AXIS, rotation:rot.X, ccw:true},
               
                "x": {cubies:[L,C,R], axis:Z_AXIS, rotation:rot.Z, ccw:false},
                "y": {cubies:[U,C,D], axis:Y_AXIS, rotation:rot.Y, ccw:false},
                "z": {cubies:[F,C,B], axis:X_AXIS, rotation:rot.X, ccw:false}
            };

            this.selectedCubes = layers[move.face].cubies;
            this.axisConstant = layers[move.face].axis;
            this.rotationAxis = layers[move.face].rotation;
            // not a true counter clockwise
            // but instead a ccw over this axis seen from origin
            if (layers[move.face].ccw) 
                inverse = !inverse;
            if (inverse) {
                vec3.scale(this.rotationAxis, this.rotationAxis, -1);
            }
            this.setRotatedCubes(move);
            isRotating = true;
        }

        this.perform = function(alg) {
            var that = this;
            var delay = 400;
            if (!isRotating && alg.length > 0) {
                var clone = alg.slice(0);
                var move = clone.shift();
                // beat();
                if (!move.count)
                    move.count = 1;
                    this.move(move);                
                this.currentMove = move;
                that.setNormals = 'MESxyz'.match(move.face)!=null;
                setTimeout(function() {that.perform(clone)}, delay);
            }
            else {
                if (alg.length > 0)
                    setTimeout(function() {that.perform(alg)}, delay);        
                else
                    this.algDone();
            }
        }

        this.algDone = function() {
            if (isRotating) {
                setTimeout(rubiksCube.algDone, 100);
            }
            else {
                isInitializing = false;
                rubiksCube.currentMove = rubiksCube.noMove;
                this.degrees = DEGREES;
            }
        }

        this.moveListToString = function(moveList) {
            return moveList.map(function(move) {
              return move.face + (move.count==2?"2":"") + (move.inverse?"'":"");
            }).join(" ");
        }

        this.inverseMoveList = function(moves) {
            return moves.reverse().map(function(move) {
              return {face:move.face, count:move.count, inverse:!move.inverse};
            });
        }
        
        this.setStickers = function(stickers) {
            var positions = "FUL,FU,FUR,FL,F,FR,FDL,FD,FDR,RFU,RU,RBU,RF,R,RB,RFD,RD,RBD,DLF,DF,DRF,DL,D,DR,DLB,DB,DRB,BUR,BU,BUL,BR,B,BL,BDR,BD,BDL,LBU,LU,LFU,LB,L,LF,LBD,LD,LFD,ULB,UB,URB,UL,U,UR,ULF,UF,URF".split(',');

            var colors = {
                r:'red',
                g:'green',
                w:'white',
                o:'orange',
                b:'blue',
                y:'yellow',
                x:'gray',
                k:'black' //key (from CMYK)
            };
            var r,g,b;
            var cube;
            var x,y,z;
            var position;
            
            var arrayRotate = function(arr, reverse){
              if(reverse)
                arr.push(arr.shift());
              else
                arr.unshift(arr.pop());
              return arr;
            } 

            for (var r = 0; r < 3; r++) {
                for (var g = 0; g < 3; g++) {
                    for (var b = 0; b < 3; b++) {
                        cube = this.cubes[r][g][b];
                        x = cube.coordinates[0];
                        y = cube.coordinates[1];
                        z = cube.coordinates[2];
                        var faces=[];
                        if (x === -1) faces.push('F'); else if (x === 1) faces.push('B');
                        if (y === -1) faces.push('U'); else if (y === 1) faces.push('D');
                        if (z === -1) faces.push('R'); else if (z === 1) faces.push('L');
                        // faces.length=1 => center
                        // faces.length=2 => edge
                        // faces.length=3 => corner
                        position = faces;
                        faces.forEach(function(value, key) {                            
                            var index = positions.indexOf(position.join(''));
                            var ch;
                            if (stickers.length >= index+1) {
                                ch = stickers.slice(index, index+1);
                                if (!"rgbwoyxk".match(ch)) {
                                    ch = 'x';
                                }
                            }
                            else {
                                ch = 'x';
                            }
                                
                            var el = cube.stickers[key];
                            var cr = parseInt(el.color[0]*255.0);
                            var cg = parseInt(el.color[1]*255.0);
                            var cb = parseInt(el.color[2]*255.0);
                            cube.stickers[key].color = cube.COLORS[colors[ch]];
                            position = arrayRotate(position, true);
                        });
                         
                        }
                    }
                }
            };
        
        
        this.reset = function() {
            this.init();            
                var alg = $(canvas).data('alg');
                var algType = $(canvas).data('type');
            // default order of RubikPlayer faces is F, R, D, B, L, U
            // we start with yellow on top
            var defaultStickers = "rrrrrrrrrgggggggggwwwwwwwwwooooooooobbbbbbbbbyyyyyyyyy";
                var stickers = $(canvas).data('stickers') || defaultStickers; 
            var stickerSets = {
                CROSS:    "xxxxrxxrxxxxxgxxgxxwxwwwxwxxxxxoxxoxxxxxbxxbxxxxxyxxxx",
                FL:       "xxxxxxrrrxxxxxxgggwwwwwwwwwxxxxxxoooxxxxxxbbbxxxxxxxxx",
                F2L:      "xxxrrrrrrxxxggggggwwwwwwwwwxxxooooooxxxbbbbbbxxxxyxxxx",
                SHORTCUT: "xxxxrrxrrxxxggxggxxwwwwwxwxxxxxoxxoxxxxxbxxbxxxxxyxxxx",
                OLL:      "xxxrrrrrrxxxggggggwwwwwwwwwxxxooooooxxxbbbbbbyyyyyyyyy",
                    PLL:      "rrrxxxxxxgggxxxxxxxxxxxxxxxoooxxxxxxbbbxxxxxxyyyyyyyyy",
                    FULL:     defaultStickers
            };
            // replace stickers by full definition of set
            if (stickerSets[stickers.toUpperCase()]) {
                stickers = stickerSets[stickers.toUpperCase()];
            }
            this.setStickers(stickers);
            perspectiveView();
            if (alg) {
                this.degrees = 90;
                    $(canvas).parent().find('.algorithm').val(alg);
                var moves = parseAlgorithm(alg);
                if (algType === 'solver') {
                isInitializing = true;
                    moves = this.inverseMoveList(moves);
                    doAlgorithm(moves);
                }
                    else {
                    isInitializing = false;
            }
                }
            else
                isInitializing = false;
        };

    }

    function Cube(rubiksCube, coordinates, color) {
        this.rubiksCube = rubiksCube;
        this.coordinates = coordinates;
        this.color = color;
        this.rotationMatrix = mat4.create();
        this.translationVector = vec3.create();
        this.stickers = [];
        this.COLORS = {
            'blue': [0.1, 0.1, 1.0, 1.0],
            'green': [0.1, 0.7, 0.1, 1.0],
            'orange': [1.0, 0.5, 0.0, 1.0],
            'red': [0.8, 0.1, 0.1, 1.0],
            'white': [1.0, 1.0, 1.0, 1.0],
            'yellow': [1.0, 1.0, 0.1, 1.0],
            'gray': [0.5, 0.5, 0.5, 1.0],
            'black': [0.0, 0.0, 0.0, 1.0]
        }

        this.init = function() {
            vec3.scale(this.translationVector, this.coordinates, 2);
            this.initStickers();
        }

        this.initStickers = function() {
            var x = this.coordinates[0];
            var y = this.coordinates[1];
            var z = this.coordinates[2];
            if (x == -1) {
                this.stickers.push(new Sticker(this, this.COLORS['red'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [-1.001, 0, 0]);
                    mat4.rotateZ(modelViewMatrix, modelViewMatrix, degreesToRadians(90));
                }));
            } else if (x == 1) {
                this.stickers.push(new Sticker(this, this.COLORS['orange'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [1.001, 0, 0]);
                    mat4.rotateZ(modelViewMatrix, modelViewMatrix, degreesToRadians(-90));
                }));
            }
            if (y == -1) {
                this.stickers.push(new Sticker(this, this.COLORS['yellow'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [0, -1.001, 0]);
                    mat4.rotateX(modelViewMatrix, modelViewMatrix, degreesToRadians(-180));
                }));
            } else if (y == 1) {
                this.stickers.push(new Sticker(this, this.COLORS['white'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [0, 1.001, 0]);
                    setMatrixUniforms();
                }));
            }
            if (z == 1) {
                this.stickers.push(new Sticker(this, this.COLORS['blue'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [0, 0, 1.001]);
                    mat4.rotateX(modelViewMatrix, modelViewMatrix, degreesToRadians(90));
                }));
            } else if (z == -1) {
                this.stickers.push(new Sticker(this, this.COLORS['green'], function() {
                    this.cube.transform();
                    mat4.translate(modelViewMatrix, modelViewMatrix, [0, 0, -1.001]);
                    mat4.rotateX(modelViewMatrix, modelViewMatrix, degreesToRadians(-90));
                }));
            }
        }

        this.init();

        this.transform = function() {
            mat4.multiply(modelViewMatrix, modelViewMatrix, this.rotationMatrix);
            mat4.translate(modelViewMatrix, modelViewMatrix, this.translationVector);
        }

        this.draw = function(color) {
            var mvMatrix = mat4.create();
            mat4.copy(mvMatrix, modelViewMatrix);
            this.transform();
            setMatrixUniforms();

            gl.uniform4fv(shaderProgram.ambient, color);
            gl.uniform4fv(shaderProgram.diffuse, cubeModel.diffuse);
            gl.uniform4fv(shaderProgram.specular, cubeModel.specular);
            gl.uniform1f(shaderProgram.shininess, cubeModel.shininess);
            // vertices
            gl.bindBuffer(gl.ARRAY_BUFFER, rubiksCube.cubeVerticesBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexPosition, 3, gl.FLOAT, false, 0, 0);
            // normals
            gl.bindBuffer(gl.ARRAY_BUFFER, rubiksCube.cubeNormalsBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexNormal, 3, gl.FLOAT, false, 0, 0);
            // faces
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rubiksCube.cubeFacesBuffer);
            gl.drawElements(gl.TRIANGLES, cubeModel.faces.length, gl.UNSIGNED_SHORT, 0);

            mat4.copy(modelViewMatrix, mvMatrix);
        }
    }

    function Sticker(cube, color, transform) {
        this.cube = cube;
        this.color = color;
        this.transform = transform;

        this.draw = function() {
            var mvMatrix = mat4.create();
            mat4.copy(mvMatrix, modelViewMatrix)
            this.transform();
            setMatrixUniforms();

            gl.uniform4fv(shaderProgram.ambient, this.color);
            gl.uniform4fv(shaderProgram.diffuse, stickerModel.diffuse);
            gl.uniform4fv(shaderProgram.specular, stickerModel.specular);
            gl.uniform1f(shaderProgram.shininess, stickerModel.shininess);
            // vertices
            gl.bindBuffer(gl.ARRAY_BUFFER, cube.rubiksCube.stickerVerticesBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexPosition, 3, gl.FLOAT, false, 0, 0);
            // normals
            gl.bindBuffer(gl.ARRAY_BUFFER, cube.rubiksCube.stickerNormalsBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexNormal, 3, gl.FLOAT, false, 0, 0);
            // faces
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cube.rubiksCube.stickerFacesBuffer);
            gl.drawElements(gl.TRIANGLES, stickerModel.faces.length, gl.UNSIGNED_SHORT, 0);

            mat4.copy(modelViewMatrix, mvMatrix);
        }
    }

    function NormalsCube() {
        this.normalsFramebuffer = null;
        this.normalsTexture = null;
        this.normalsRenderbuffer = null;
        this.verticesBuffer = null;
        this.normalsBuffer = null;
        this.facesBuffer = null;
        this.COLORS = {
            'blue': [0.0, 0.0, 1.0, 1.0],
            'green': [0.0, 1.0, 0.0, 1.0],
            'orange': [1.0, 0.5, 0.0, 1.0],
            'red': [1.0, 0.0, 0.0, 1.0],
            'black': [0.0, 0.0, 0.0, 1.0],
            'yellow': [1.0, 1.0, 0.0, 1.0]
        }
        this.NORMALS = {
            'blue': [-1, 0, 0],
            'green': [0, 0, -1],
            'orange': [1, 0, 0],
            'red': [0, 0, 1],
            'black': [0, -1, 0],
            'yellow': [0, 1, 0]
        }
        this.init = function() {
            this.initTextureFramebuffer();
            this.initBuffers();
        }

        this.initTextureFramebuffer = function() {
            this.normalsFramebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalsFramebuffer);

            this.normalsTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.normalsTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

            this.normalsRenderBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, this.normalsRenderBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, canvas.width, canvas.height);

            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.normalsTexture, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.normalsRenderBuffer);

            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }

        this.initBuffers = function() {
            // vertices
            this.verticesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normalsCubeModel.vertices), gl.STATIC_DRAW);
            // normals
            this.normalsBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.normalsBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normalsCubeModel.normals), gl.STATIC_DRAW);
            // faces
            this.facesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.facesBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(normalsCubeModel.faces), gl.STATIC_DRAW);
        }

        this.init();

        this.draw = function() {
            var mvMatrix = mat4.create();
            mat4.copy(mvMatrix, modelViewMatrix);
            mat4.scale(modelViewMatrix, modelViewMatrix, [3, 3, 3]);
            setMatrixUniforms();

            gl.uniform1i(shaderProgram.lighting, 0);
            // vertices
            gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexPosition, 3, gl.FLOAT, false, 0, 0);
            // normals
            gl.bindBuffer(gl.ARRAY_BUFFER, this.normalsBuffer);
            gl.vertexAttribPointer(shaderProgram.vertexNormal, 3, gl.FLOAT, false, 0, 0);
            // faces
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.facesBuffer);
            var offset = 0;
            for (var c in this.COLORS) {
                var color = this.COLORS[c];
                gl.uniform4fv(shaderProgram.ambient, this.COLORS[c]);
                gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, offset);
                gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, offset + normalsCubeModel.faces.length)
                offset += 6;
            }

            mat4.copy(modelViewMatrix, mvMatrix);
            gl.uniform1i(shaderProgram.lighting, 1);
        }

        this.colorToNormal = function(rgba) {
            var r = (rgba[0] / 255).toFixed(1);
            var g = (rgba[1] / 255).toFixed(1);
            var b = (rgba[2] / 255).toFixed(1);
            for (var c in this.COLORS) {
                var color = this.COLORS[c];
                if (r == color[0] && g == color[1] && b == color[2]) {
                    return this.NORMALS[c];
                }
            }
            return null;
        }

        this.getNormal = function(x, y) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalsFramebuffer);
            var pixelValues = new Uint8Array(4);
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixelValues);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return this.colorToNormal(pixelValues);
        }
    }

    function initWebGL(canvas) {
        if (!window.WebGLRenderingContext) {
            console.log("Your browser doesn't support WebGL.")
                return null;
        }
        gl = canvas.getContext('webgl', {preserveDrawingBuffer: true, antialias:true}) || canvas.getContext('experimental-webgl', {preserveDrawingBuffer: true, antialias:true});
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        if (!gl) {
            console.log("Your browser supports WebGL, but initialization failed.");
            return null;
        }
        return gl;
    }

    function getShader(gl, id) {
        var shaderScript = document.getElementById(id);
        if (!shaderScript) {
            return null;
        }
        var source = '';
        var currentChild = shaderScript.firstChild;
        while (currentChild) {
            if (currentChild.nodeType == currentChild.TEXT_NODE) {
                source += currentChild.textContent;
            }
            currentChild = currentChild.nextSibling;
        }
        var shader;
        if (shaderScript.type == 'x-shader/x-fragment') {
            shader = gl.createShader(gl.FRAGMENT_SHADER);
        } else if (shaderScript.type == 'x-shader/x-vertex') {
            shader = gl.createShader(gl.VERTEX_SHADER);
        } else {
            return null;
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.log('An error occurred while compiling the shader: ' + gl.getShaderInfoLog(shader));
            return null;
        }
        return shader;
    }

    function initShaders() {
        var fragmentShader = getShader(gl, 'fragmentShader');
        var vertexShader = getShader(gl, 'vertexShader');
        shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, fragmentShader);
        gl.attachShader(shaderProgram, vertexShader);
        gl.linkProgram(shaderProgram);
        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
            console.log('Unable to initialize the shader program');
        }
        gl.useProgram(shaderProgram);
        shaderProgram.vertexPosition = gl.getAttribLocation(shaderProgram, 'vertexPosition');
        gl.enableVertexAttribArray(shaderProgram.vertexPosition);
        shaderProgram.vertexNormal = gl.getAttribLocation(shaderProgram, 'vertexNormal');
        gl.enableVertexAttribArray(shaderProgram.vertexNormal);
        shaderProgram.eyePosition = gl.getUniformLocation(shaderProgram, 'eyePosition');
        gl.uniform3fv(shaderProgram.eyePosition, eye);
        shaderProgram.lighting = gl.getUniformLocation(shaderProgram, 'lighting');
        shaderProgram.ambient = gl.getUniformLocation(shaderProgram, 'ambient');
        shaderProgram.diffuse = gl.getUniformLocation(shaderProgram, 'diffuse');
        shaderProgram.specular = gl.getUniformLocation(shaderProgram, 'specular');
        shaderProgram.shininess = gl.getUniformLocation(shaderProgram, 'shininess');
    }

    function drawScene() {
        if (isRotating) {
            rubiksCube.rotateLayer(rubiksCube.currentMove.count > 1);
        }

        rubiksCube.drawToNormalsFramebuffer();
        rubiksCube.drawToPickingFramebuffer(); 
        // if (!isInitializing) {
          rubiksCube.draw();
        // }
    }

    function tick() {
        requestAnimationFrame(tick);
        drawScene();
    }

        function start(el) {
            canvas = el;
            CANVAS_X_OFFSET = $(canvas).offset()['left'];
            CANVAS_Y_OFFSET = $(canvas).offset()['top'];
        gl = initWebGL(canvas);
        initShaders();
        rubiksCube = new RubiksCube();
        perspectiveView();

        if (gl) {
            gl.clearColor(1.0, 1.0, 1.0, 1.0);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            tick();
        }
    }

    function setMatrixUniforms() {
        var projectionUniform = gl.getUniformLocation(shaderProgram, 'projectionMatrix');
        gl.uniformMatrix4fv(projectionUniform, false, projectionMatrix);
        var modelViewUniform = gl.getUniformLocation(shaderProgram, 'modelViewMatrix');
        gl.uniformMatrix4fv(modelViewUniform, false, modelViewMatrix);
        var _normalMatrix = mat4.create();
        mat4.invert(_normalMatrix, modelViewMatrix);
        mat4.transpose(_normalMatrix, _normalMatrix);
        var normalMatrix = mat3.create();
        mat3.fromMat4(normalMatrix, _normalMatrix);
        var normalMatrixUniform = gl.getUniformLocation(shaderProgram, 'normalMatrix');
        gl.uniformMatrix3fv(normalMatrixUniform, false, normalMatrix);
    }

    function unproject(dest, vec, view, proj, viewport) {
        var m = mat4.create();
        var v = vec4.create();

        v[0] = (vec[0] - viewport[0]) * 2.0 / viewport[2] - 1.0;
        v[1] = (vec[1] - viewport[1]) * 2.0 / viewport[3] - 1.0;
        v[2] = 2.0 * vec[2] - 1.0;
        v[3] = 1.0;

        mat4.multiply(m, proj, view);
        mat4.invert(m, m);

        vec4.transformMat4(v, v, m);
        if (v[3] == 0.0) {
            return null;
        }

        dest[0] = v[0] / v[3];
        dest[1] = v[1] / v[3];
        dest[2] = v[2] / v[3];

        return dest;
    }

    function screenToObjectCoordinates(x, y) {
        var objectCoordinates = vec3.create();
        var screenCoordinates = [x, y, 0];
        unproject(objectCoordinates, screenCoordinates, modelViewMatrix, projectionMatrix, [0, 0, canvas.width, canvas.height])
        return objectCoordinates;
    }

    function degreesToRadians(degrees) {
        return degrees * Math.PI / 180;
    }

    function rotate(event) {
        if (rightMouseDown) {
            x_init_right = event.clientX;
            y_init_right = event.clientY;
            var delta_x = parseInt((x_new_right - x_init_right) * 360 / this.width);
            var delta_y = parseInt((y_new_right - y_init_right) * 360 / this.width);
   
            var axis = [-delta_y, delta_x, 0];
            var degrees = Math.sqrt(delta_x * delta_x + delta_y * delta_y);
            var newRotationMatrix = mat4.create();
            mat4.rotate(newRotationMatrix, newRotationMatrix, degreesToRadians(degrees), axis);
            mat4.multiply(rotationMatrix, newRotationMatrix, rotationMatrix);
        } else if (leftMouseDown && !isRotating) {
            new_coordinates = screenToObjectCoordinates(event.pageX - CANVAS_X_OFFSET, canvas.height - event.pageY + CANVAS_Y_OFFSET);
            var direction = vec3.create();
            vec3.subtract(direction, new_coordinates, init_coordinates);
            vec3.normalize(direction, direction);
            rubiksCube.setRotationAxis(event.pageX - CANVAS_X_OFFSET, canvas.height - event.pageY + CANVAS_Y_OFFSET, direction);
            rubiksCube.setRotatedCubes();
            isRotating = rubiksCube.rotatedCubes && rubiksCube.rotationAxis;
        }
        x_new_right = event.clientX;
        y_new_right = event.clientY;    
    }

    function startRotate(event) {
        if (event.button == LEFT_MOUSE) { // left mouse
            rubiksCube.selectedCubes = [];
            rubiksCube.selectCube(event.pageX - CANVAS_X_OFFSET, canvas.height - event.pageY + CANVAS_Y_OFFSET);
            if (rubiksCube.selectedCubes.length > 0) {            
                init_coordinates = screenToObjectCoordinates(event.pageX - CANVAS_X_OFFSET, canvas.height - event.pageY + CANVAS_Y_OFFSET);
                setTimeout(function() {
                    leftMouseDown = true;
                }, 50);
            }
        } else if (event.button == RIGHT_MOUSE) { // right mouse
            rightMouseDown = true;
            x_init_right = event.pageX;
            y_init_right = event.pageY;
        }
    }

    function endRotate(event) {
        if (event.button == LEFT_MOUSE && leftMouseDown) { // left mouse
            leftMouseDown = false;
            rubiksCube.algDone();
        } else if (event.button == RIGHT_MOUSE) { // right mouse
            rightMouseDown = false;
        }
    }

    function topView() {
        mat4.identity(rotationMatrix);
        mat4.rotateX(rotationMatrix, rotationMatrix, degreesToRadians(90));
    }

    function bottomView() {
        mat4.identity(rotationMatrix);
        mat4.rotateX(rotationMatrix, rotationMatrix, degreesToRadians(-90));
    }

    function leftView() {
        mat4.identity(rotationMatrix);
        mat4.rotateY(rotationMatrix, rotationMatrix, degreesToRadians(-90));
    }

    function rightView() {
        mat4.identity(rotationMatrix);
        mat4.rotateY(rotationMatrix, rotationMatrix, degreesToRadians(90));
    }

    function frontView() {
        mat4.identity(rotationMatrix);
    }

    function backView() {
        mat4.identity(rotationMatrix);
        mat4.rotateY(rotationMatrix, rotationMatrix, degreesToRadians(180));
    }

    function perspectiveView() {
        mat4.identity(rotationMatrix);
        mat4.rotateX(rotationMatrix, rotationMatrix, degreesToRadians(30));
        mat4.rotateY(rotationMatrix, rotationMatrix, degreesToRadians(-50));
        mat4.rotateZ(rotationMatrix, rotationMatrix, degreesToRadians(0));
    }

    function togglePerspective(event) {
        switch(event.which) {
            case 32: // space
                perspectiveView();
                break;
            case 97: // a, left
                leftView();
                break;
            case 100: // d, right
                rightView();
                break;
            case 101: // e, top
                topView();
                break;
            case 113: // q, bottom
                bottomView();
                break;
            case 115: // s, back
                backView();
                break;
            case 119: // w, front
                frontView();
                break;
        }
    }

    function testLayerMoves() {
        if (!isAnimating) {
            isAnimating = true;
            rubiksCube.perform([
                {face:"R", inverse:false},
                {face:"R", inverse:true},
                {face:"L", inverse:false},
                {face:"L", inverse:true},
                {face:"U", inverse:false},
                {face:"U", inverse:true},
                {face:"D", inverse:false},
                {face:"D", inverse:true},
                {face:"F", inverse:false},
                {face:"F", inverse:true},
                {face:"B", inverse:false},
                {face:"B", inverse:true},
                {face:"M", inverse:false},
                {face:"M", inverse:true},
                {face:"E", inverse:false},
                {face:"E", inverse:true},
                {face:"S", inverse:false},
                {face:"S", inverse:true} 
                ]);
            return;
        }
    }

        function scramble() {
        var count;
        isInitializing = false;
        if (!isAnimating) {
            isAnimating = true;

                if ($(canvas).parent().find('.scramble-length'))
                    count = parseInt($(canvas).parent().find('.scramble-length').val());
            else
                count = Math.floor(Math.random() * 10) + 10;
            var moves = ['R','L','U','D','F','B'];
            var movesWithSlices = ['R','L','U','D','F','B','M','E','S'];
            var moveList = [];
            var moveIndex = 0;
            var prevIndex = 0;
            var randomMove;
            var inverse = false;
            var moveCount = 1;
            for (var i = 0; i < count; i++) {
                moveIndex = Math.floor(Math.random() * moves.length);
                while (moveIndex/2 == prevIndex/2) {
                    moveIndex = Math.floor(Math.random() * moves.length);
                }
                randomMove = moves[moveIndex];
                prevIndex = moveIndex;
                moveCount = 1 + Math.floor(Math.random()*2);
                inverse = moveCount==1 && Math.random() < 0.5;
                moveList.push({face:randomMove, inverse:inverse, count:moveCount});            
            }
            rubiksCube.perform(moveList);
        var ret = rubiksCube.moveListToString(moveList);
                $(canvas).parent().find('.moveList').text(ret);
        }
        return ret;
    }

    function parseAlgorithm(algorithm) {
        var alg = algorithm;
        alg = alg.replace(/ /g, '');
            alg = alg.replace(/'/g,'3');
        alg = alg.replace(/-/g,'3');
        alg = alg.replace(/([^LRUDFBMESxyz0123456789])/gi,"");
            // add count where necessary
        alg = alg.replace(/([LRUDFBMESxyz])([^0-9])/ig,"$11$2");
        alg = alg.replace(/([LRUDFBMESxyz])([^0-9])/ig,"$11$2");
        alg = alg.replace(/([0-9])([LRUDFBMESxyz])/ig,"$1,$2");
        alg = alg.replace(/([LRUDFBMESxyz])$/i,"$11");

            var moveList = alg.split(",")
                .map(function(el){
                  var n = 1*el.charAt(1);
                  return {
                      face:el.charAt(0),
                      inverse: n==3,
                      count:(""+n).replace(3,1)}
                });

        return moveList;
    }
    
    function doAlgorithm(moves) {
        if (!isAnimating) {
            isAnimating = true;

            rubiksCube.perform(moves);
        }
    }
    
    function initControls() {
        $('#controls .btn').click(function() {
            var arrControls = [
                "R","L","U","D","F","B",
                "R-prime","L-prime","U-prime","D-prime","F-prime","B-prime",
                "R2","L2","U2","D2","F2","B2"
                ];
            var control = this.id.replace('move-','');        
            var prime = false;
            var doubleMove = false;
            if (control.match('prime'))
                prime = true;
            if (control.match('2'))
                doubleMove = true;
            var layer = control.charAt(0);
            var moveList = [];
            moveList.push({face:layer, inverse:prime, count:doubleMove?2:1});            
            rubiksCube.perform(moveList);
        });
    }

        // public interface
        this.start = start;
        this.reset = function() { rubiksCube.reset(); };
        this.rubiksCube = function() { return rubiksCube; };
        this.initControls = function() { initControls(); };
        this.parseAlgorithm = parseAlgorithm;
        this.doAlgorithm = doAlgorithm;
        this.scramble = scramble;
        this.rotate = rotate;
        this.startRotate = startRotate;
        this.endRotate = endRotate;
        this.togglePerspective = togglePerspective;
    };
    
    // global scope
    $(document).ready(function() {
        $('.glube').each(function(){
            var glube = new GLube;

            // animation
            $(this).find('canvas').each(function() {
                var canvas = this;
                glube.start(this);
                $(this).bind('contextmenu', function(e) { return false; });
                $(this).mousedown(glube.startRotate);
                $(this).mousemove(glube.rotate);
                $(this).mouseup(glube.endRotate);
                glube.reset();
                glube.initControls();
        });
            // controls         
            $(this).find('.reset-cube').click(function() {glube.reset();});
            $(this).find('.scramble-cube').click(function() {glube.scramble()});
            $(this).find('.run-alg').click(function() {
                glube.isInitializing = false; 
                var alg = $(this).prev().find('.algorithm').val();
                var moves = glube.parseAlgorithm(alg);
                glube.doAlgorithm(moves);
    });
        });  
    });
    
})();

is_major = true;
position = 0;
major_array = [ "[CEG]4", "[_DF_A]4", "[D_GA]4", "[_EG_B]4", "[E_AB]4", "[FAC]4", "[_G_B_D]4", "[GBD]4", "[_AC_E]4", 
"[A_DE]4", "[_BDF]4", "[B_E_G]4"];
minor_array = ["[C_AF]4", "[_DA_G]4", "[D_BG]4", "[_EB_A]4", "[ECA]4", "[F_D_B]4", "[_GDB]4", "[G_EC]4", "[_AE_D]4", "[AFD]4", "[_B_G_E]4", "[BGE]4"];
twinkle = ["CCGG", "AAG2", "FFEE", "DDC2", "GGFF", "EED2", "GGFF", "EED2", "CCGG", "AAG2", "FFEE", "DDC2"];
twinkle_beat1 = ["[C]4", "[C]4", "[G]4", "[G]4", "[A]4", "[A]4", "[G2]4", "[G]4", "[F]4", "[F]4", "[E]4", "[E]4"];
twinkle_beat2 = ["C", "C", "G", "G", "A", "A", "G2", "F", "F", "E", "E", "D", "D", "C2:", ":G", "G", "F", "F", "E", "E", "D2", "G", "G", "F", "F", "E", "E", "D2", "C", "C", "G", "G", "A", "A", "G2", "F", "F", "E", "E", "D", "D", "C2:"];
twinkle_beat = ["[C]4", "[C]4", "[G]4", "[G]4", "[A]4", "[A]4", "[G2]4", "[F]4", "[F]4", "[E]4", "[E]4", "[D]4", "[D]4", "[C2:]4", "[:G]4", "[G]4", "[F]4", "[F]4", "[E]4", "[E]4", "[D2]4", "[G]4", "[G]4", "[F]4", "[F]4", "[E]4", "[E]4", "[D2]4", "[C]4", "[C]4", "[G]4", "[G]4", "[A]4", "[A]4", "[G2]4", "[F]4", "[F]4", "[E]4", "[E]4", "[D]4", "[D]4", "[C2:]4"];
var inst = new Instrument('piano');
// inst.silence();
// Play a single tone immediately.  Tones may be also specified
// numerically (in Hz), or with midi numbers (as negative integers).
inst.tone('C');

function beat() {
  if (is_major){
  inst.play(twinkle_beat[position]);
  }
  else{
    inst.play(twinkle_beat[position]);
  }
}