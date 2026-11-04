// Tester-facing words for feedback composers, mirroring docs/feedback-copy-v1.json apart from its note
// (a test compares them), and the logs control as a pure function of the host's facts. No DOM, no state.
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export const FEEDBACK_COPY=freeze({
  v:1,
  inks:{
    default:"red",
    red:[255,0,0],
    yellow:[255,204,0],
    blue:[0,122,255],
    white:[255,255,255],
  },
  labels:{
    title:"Send feedback",
    includeScreenshot:"Include screenshot",
    sendLogs:"Send recent logs with this report",
    move:"Move",
    pen:"Pen",
    redact:"Redact",
    undo:"Undo",
    clearEdits:"Clear edits",
    cancel:"Cancel",
    done:"Done",
    screenshotLeftOut:"screenshot left out",
  },
  notes:{
    capturedScreen:"This is the screen you were on. It stays on this device unless you send it. Check it for private information, then keep or remove it.",
    imageTools:"{action} the image to zoom in, draw on it or cover part of it.",
    screenshotLeftOut:"This image won't be sent. It stays here, with any edits, until you close this form, so you can include it again.",
    edited:"You edited this image, and this flattened copy is the one that will be sent. {action} the image to change or clear your edits, until you send. After that they're permanent. Only areas you covered with Redact are hidden, so check the rest for private information.",
    editedFinal:"Edits you made before sending are now part of this image and can't be undone, so anything you covered stays covered. To start over, remove it. You can add marks, and clear those, until you send again. Only areas you covered with Redact are hidden, so check the rest for private information.",
    unavailableSecure:"No screenshot was taken, because a secure text field was active. You can still send a note.",
    unavailableFailed:"The screen couldn't be captured, so no screenshot is attached. You can still send a note.",
    emptySend:"Add a note or include a screenshot to send.",
    cannotFinish:"This image couldn't be prepared. It hasn't changed.",
    capturePending:"Preparing the image…",
  },
  confirm:{
    clearReversible:"Clear all edits? The original image comes back, including anything you covered, and that's what will be sent.",
    clearFinal:"Clear the marks you added since sending? Edits from before that are part of the image and stay, so anything you covered then stays covered.",
  },
  editorHints:{
    move:"Zoom and drag to look closely. To hide something, choose Redact.",
    pen:"Drawing only marks the image, and what's under a line may still show. To hide something, choose Redact.",
    redact:"Drag over what to hide. That area becomes solid black in the image you send. It only covers what you cover, so check the rest.",
  },
  logs:{
    addsExcerpt:"Recent events may already have been sent. This report also sends a copy of any that haven't, labeled with its ID. That copy may be empty.",
    disabledSettingsOff:"Recent logs can't be sent because diagnostics are off in Settings.",
    disabledNotEnrolled:"Recent logs can't be sent until feedback is connected.",
    disabledUnavailable:"Recent logs can't be sent with this report right now.",
    automaticWhileEnrolled:"While you're connected, this app automatically sends the developer {dataClasses}. That happens whether or not you send a report.",
    automaticSeparateConsent:"Automatic diagnostics are a separate choice in Settings.",
    automaticNone:"This app isn't sending diagnostic data automatically.",
    dataClasses:{
      events:"event names",
      timings:"counts and timings",
      errors:"error classes",
      ids:"random session and connection IDs",
      gameplay:"gameplay details",
    },
    addsLines:"This report also includes the recent log lines shown here.",
    addsMarker:"Whether or not this is on, a marker with this report's ID goes with your diagnostics.",
    replayUploads:"While you're connected and diagnostics are on, this game also uploads recordings of your play for the developer automatically.",
    replayServerRecords:"The game server records matches whatever you choose here. This setting only controls uploads from this device.",
    replayOffClears:"Turning diagnostics off stops recording and clears replay data not yet uploaded.",
    replayOffStops:"Turning diagnostics off stops new recording.",
    addsLinesSeparate:"The recent log lines shown here are sent separately from this report.",
    linesLostOnQuit:"If the app quits before they're sent, they may be lost.",
    replayDeviceOffClears:"Turning diagnostics off stops uploads from this device and clears uploads not yet sent.",
    replayDeviceOffStops:"Turning diagnostics off stops uploads from this device.",
    automaticSwitch:"This switch doesn't change that.",
    addsExcerptOnly:"This report also sends a copy of recent events, labeled with its ID. That copy may be empty.",
    replayServerRecordsOnly:"The game server records matches whatever you choose here.",
    markerStill:"A marker with this report's ID still goes with your diagnostics.",
  },
  status:{
    saving:"Saving…",
    savedSending:"Saved, sending…",
    savedSendingDetail:"Your report is saved on this device. You can close this. If it doesn't finish, it will send when the app is open and online.",
    sent:"Sent",
    sentDetail:"The service confirmed it received your report.",
    savedOffline:"Saved. It will send when the app is open and online.",
    serviceBusy:"The service couldn't take your report just now. Saved. It will retry while the app is open and online.",
    accessRequired:"Feedback needs a new invitation. Your report stays on this device. After you reconnect, you'll choose whether to send it.",
    heldForEnrollment:"Your report was saved under a previous connection and hasn't been sent. It stays on this device until you send or clear it.",
    heldPrompt:"Send {count} reports saved under a previous connection with this one?",
    heldClearPrompt:"Clear reports saved under a previous connection? They won't be sent.",
    enrollmentChanged:"Your connection changed before this was saved, so it hasn't been sent. Review it and send again.",
    rejected:"The service didn't accept this report. It stays on this device until you clear it, and it won't be retried.",
    storageFull:"Not saved: local feedback storage is full. Your draft is still here.",
    storageUnconfirmed:"Couldn't confirm this saved, because local storage reported an error. Your draft is still here, so you can try Send again. A copy may still send.",
    tooLarge:"Not saved: use at most 2,000 characters and an image up to 8 MiB. Your draft is still here.",
    enrollmentRejected:"This app could not accept the connection response. Ask for a new invitation or update the app.",
    queueFullHeld:"{count} reports are already waiting on this device, including some from a previous connection. Send or clear those first.",
    queueFullBlocked:"{count} reports are already waiting on this device and can't send right now. Reconnect feedback in Settings, then try again.",
    queueFullWaiting:"{count} reports are already waiting on this device. They'll send when the app is open and online, then you can send this one.",
  },
  editor:{
    screenshot:"Screenshot",
    mark:"mark",
    marks:"marks",
    zoom:"zoom",
    zoomIn:"Zoom in",
    zoomOut:"Zoom out",
    zoomFit:"Show whole image",
    tools:"Tool",
    inks:"Pen color",
    views:"Image",
    keysMove:"Arrow keys move the image, + and - zoom, and 0 shows all of it.",
    keysDraw:"Arrow keys move the crosshair, and Shift moves it further. Space or Enter starts and ends a mark.",
    red:"Red",
    yellow:"Yellow",
    blue:"Blue",
    white:"White",
  },
});

/** Fills {action} ('Tap' on touch, 'Click' with a mouse), {count} and the like. */
export function fillCopy(text,values){return text.replace(/\{(\w+)\}/g,(whole,key)=>Object.hasOwn(values,key)?String(values[key]):whole);}
export const actionWord=touch=>touch?'Tap':'Click';

const REASONS=Object.freeze({'settings-off':'disabledSettingsOff','not-enrolled':'disabledNotEnrolled',unavailable:'disabledUnavailable'});
const listed=items=>items.length<2?items.join(''):`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;

/**
 * The checkbox state and its words, built from the host's true facts: a sentence appears only if its
 * fact is true. `checked` is the tester's current choice, because what the report adds depends on it.
 */
export function logsControl({attach='none',available=false,unavailableReason='unavailable',marker=false,automatic='none',dataClasses=[],lines=null,replay=null,checked=true}={},copy=FEEDBACK_COPY){
  const logs=copy.logs,shown=attach==='excerpt'||attach==='report-lines',enabled=shown&&available===true,on=enabled&&checked!==false;
  const why=Object.hasOwn(REASONS,unavailableReason)?unavailableReason:'unavailable';
  if(attach==='report-lines'&&enabled&&lines?.delivery!=='in-report'&&lines?.delivery!=='separate')throw TypeError('report-lines needs lines.delivery while available.');
  if(automatic!=='none'&&automatic!=='while-enrolled'&&automatic!=='separate-consent')throw TypeError('Unknown automatic telemetry fact.');
  const explanation=[];
  // Off in Settings can't also be sending automatically, so the two are never both said.
  const offInSettings=shown&&!enabled&&why==='settings-off',uploading=Boolean(replay?.uploads)&&!offInSettings;
  let automaticSentence=false;
  if(automatic==='while-enrolled'){
    const classes=Object.keys(logs.dataClasses).filter(name=>dataClasses.includes(name));
    if(!classes.length||classes.length!==new Set(dataClasses).size)throw TypeError('dataClasses must name what automatic telemetry contains.');
    if(!offInSettings){explanation.push(fillCopy(logs.automaticWhileEnrolled,{dataClasses:listed(classes.map(name=>logs.dataClasses[name]))}));automaticSentence=true;}
  }else if(automatic==='separate-consent'){explanation.push(logs.automaticSeparateConsent);automaticSentence=true;}
  // Uploading replays is automatic too, so saying nothing is sent wouldn't be true.
  else if(!uploading)explanation.push(logs.automaticNone);
  if(shown&&automaticSentence)explanation.push(logs.automaticSwitch);
  if(on&&attach==='excerpt')explanation.push(automatic==='none'?logs.addsExcerptOnly:logs.addsExcerpt);
  if(on&&attach==='report-lines'){
    if(lines.delivery==='separate'){
      explanation.push(logs.addsLinesSeparate);
      if(lines.lostOnQuit===true)explanation.push(logs.linesLostOnQuit);
    }else explanation.push(logs.addsLines);
    if(typeof lines.retention==='string'&&lines.retention)explanation.push(lines.retention);
  }
  if(enabled&&marker===true&&automatic!=='none')explanation.push(logs.addsMarker);
  // A box that can't be on still says so: off in Settings or not connected, no marker goes.
  else if(shown&&!enabled&&why==='unavailable'&&marker===true&&automatic!=='none')explanation.push(logs.markerStill);
  if(replay){
    if(uploading)explanation.push(logs.replayUploads);
    if(replay.serverRecords)explanation.push(uploading?logs.replayServerRecords:logs.replayServerRecordsOnly);
    // Where a server records regardless, the switch only governs this device, never "stops recording".
    if(uploading)explanation.push(replay.serverRecords
      ?(replay.offClearsQueue?logs.replayDeviceOffClears:logs.replayDeviceOffStops)
      :(replay.offClearsQueue?logs.replayOffClears:logs.replayOffStops));
  }
  return Object.freeze({shown,enabled,checked:on,label:copy.labels.sendLogs,reason:shown&&!enabled?logs[REASONS[why]]:null,explanation:Object.freeze(explanation)});
}
