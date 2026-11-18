# Alerts and notifications

While Pierside is open it watches the active engine and tells you about problems you would otherwise only find by looking:

| Problem | When Pierside reports it |
|---|---|
| **Out of memory** | A container was killed by the system for using more memory than it may. |
| **Unhealthy** | A container's health check started failing. |
| **Keeps restarting** | A container exited by itself three times within five minutes and Docker started it again each time. |
| **Swarm task keeps failing** | The same task of a Swarm service failed three times within five minutes, on any node. |

Each one appears as a message at the bottom right of the window.

## How often

Pierside tells you about a problem once, not about every failure:

- **While it goes on, it stays quiet.** A container that was reported isn't reported again, for any reason, while it keeps failing: a container in a restart loop also turns unhealthy after each start, and that isn't a second alert. A Swarm service is one alert, however many of its tasks fail.
- **A reminder every two hours** if it never stops, saying how long it has been going on.
- **After fifteen minutes without a failure the problem is over.** If it starts again after that, it is reported again.
- **Alerts arriving together are one message** ("3 alerts"), not a queue of messages one after another. The message stays while the pointer is on it.

In the message:

- **Mute 1 h** silences what the message is about (that container, by its name, so also when it is recreated; that Swarm service; that engine) for an hour. **Mute these 1 h** does that for every alert in a message with several.
- **Pause all 15 min** silences every alert for a quarter of an hour, for example while you are fixing the problem.

Both also silence the desktop notifications, and last when you switch engines.

## Restart loops

A container is in a restart loop when it has a restart policy (`always`, `unless-stopped`, `on-failure`) and keeps exiting. Pierside tells two kinds apart, because the fix differs:

- **It keeps crashing** (exit code other than 0): something is wrong in the container. The message gives the exit code; look at its logs.
- **Its command keeps finishing** (exit code 0): the container does its job, ends, and Docker starts it again. If it is meant to run once, change its restart policy to `no` or `on-failure`.

Stopping, restarting or killing a container yourself is never counted, whether you do it in Pierside, with `docker`, or with Compose: Docker marks those differently from a container that exits by itself. Docker waits longer before each new attempt, up to a minute, which is why the window is five minutes.

A container without such a restart policy is never reported, however often it exits: Docker doesn't restart it, so something else is starting it again. CI runners do this, for example GitLab Runner reuses its job containers for each stage of a job.

On the Containers page, a container that is restarting or unhealthy also shows in the sidebar's red badge.

## Swarm services

A failing Swarm task is replaced by a new one each time, possibly on another node, so Pierside looks at the service's tasks instead of at single containers, twice a minute. It reports a service when the same task slot (for a global service: the same node) failed or was rejected three times within five minutes, and gives Swarm's reason, for example a non-zero exit code or an image that can't be found. Several replicas of a service each finishing once is not reported. When several of a service's tasks keep failing, as with an image that doesn't exist, it is one alert for the service. The same Swarm added as more than one engine (several managers) is reported once. This needs the active engine to be a Swarm manager.

## Server alerts

For an SSH engine, switch on **Alert me about this server** on its **Server performance** page. Pierside then checks that server every 30 seconds, whichever engine is active, and tells you when:

- **memory is almost full** (less than 10 % available, on two checks in a row);
- **it keeps swapping** (more than 1 MB/s on two checks in a row): memory is short, and everything slows down;
- **the load stays high** (more than 1.5 per CPU over 5 minutes, on three checks in a row);
- **a disk is almost full** (90 %, and as an error from 97 %).

A short spike isn't reported. The same alert comes again after half an hour at the earliest, a full disk after six hours.

## Desktop notifications

Click the version number in the bottom bar and switch on **Desktop notifications for container problems**. Pierside then also shows a notification of your operating system for each alert, at most one every 30 seconds: alerts in between come together in the next one. Switching it on shows a sample, so you can see that it works on your computer.

- **In Rancher Desktop** the notification is shown by Rancher Desktop itself. Its title is always "Warning" or "Error"; the text starts with "Pierside" and says what happened and on which engine. Clicking it does nothing. It appears for every alert, also while you are looking at Pierside.
- **In the separate window** it is your browser's notification, which asks for permission once. Clicking it goes to the container's logs or the service. It appears only when the Pierside window isn't the one in front.

With Pierside open in Rancher Desktop and in the separate window at the same time, each shows its own notification, so you get two.

Alerts cover the engine that is active, and every engine you watch in the background (**Engines at a glance**, see [Remote engines](remote-engines.md#watching-an-engine-in-the-background)); an alert about another engine than the active one starts with its name. A watched engine that can't be reached is reported too, and again when it is back.

Notifications need Pierside to be open: in Rancher Desktop with the Pierside tab shown, or in the separate window. Watched engines are watched while Rancher Desktop runs, even with Pierside closed; what happened in the meantime is listed under **Recent alerts** on the Engines at a glance page (until Rancher Desktop is restarted). The active engine is watched only while Pierside is open, unless you watch it in the background too.
