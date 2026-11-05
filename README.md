# Call Recorder

A private audio recorder for in-person meetings and speakerphone calls. It runs in Chrome on Android, can be installed to the home screen, and works offline after the first load. Recordings stay in this browser on the phone. They are never uploaded.

**Live app:** https://brantfossey.github.io/call-recorder/

GitHub Pages should deploy from the `main` branch, folder `/ (root)`.

## Install on Android

1. Open https://brantfossey.github.io/call-recorder/ in Chrome.
2. When Chrome asks, allow the microphone.
3. Tap the Chrome menu (⋮) and choose **Install app** or **Add to Home screen**.
4. Open **Call Recorder** from the home screen. After that first online visit, it also opens offline.

## Recording

Put a phone call on speaker. A web page can only record the microphone, not the cellular call itself. Set the phone where it can hear both people, then tap **Record**.

Let the other person know they're being recorded.

While you are recording, the app saves audio on the phone about every two seconds and keeps the screen awake when Android allows it. Leave the page open and in front. If Chrome is closed, the screen locks, or the tab reloads, open the app again. The take shows up in the list as recovered. Only the last couple of seconds can be missing.

Pause and Resume continue the same take. Stop saves it. You can rename it, play it, delete it (after a confirmation), download it, or share the file to OneDrive, email, or another app.

## Why the microphone processing is off

Echo cancellation, noise suppression, and auto gain start **off**. They can be turned on under **Microphone settings**. The choice is saved on the phone.

- **Echo cancellation** treats sound coming out of the speaker as echo and removes it. On a speakerphone call, that sound is the other person, so leaving it off is the point of this app. If a phone forces it back on, the settings note says so.
- **Noise suppression** is tuned for one close voice and can dull or drop quieter people around a table.
- **Auto gain** rides the volume up and down, which pumps the room noise during pauses.

Turn one on if wind, noise, or distance makes voices hard to hear. The change applies the next time you tap Record.

## Privacy

Audio is stored in IndexedDB for this site in Chrome. Nothing is sent to a server. A file leaves the phone only when you tap Download or Share. Clearing this site's data in Chrome deletes the recordings. Installing the app makes Chrome less likely to clear them when storage is low.
