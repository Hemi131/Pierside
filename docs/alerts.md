# Alerts and notifications

While Pierside is open it watches the active engine and tells you about problems you would otherwise only find by looking:

| Problem | When Pierside reports it |
|---|---|
| **Out of memory** | A container was killed by the system for using more memory than it may. |
| **Unhealthy** | A container's health check started failing. |
| **Keeps restarting** | A container exited by itself three times within five minutes and Docker started it again each time. |
| **Swarm task keeps failing** | The same task of a Swarm service failed three times within five minutes, on any node. |

Each one appears as a message at the bottom of the window. The same problem is not repeated for five minutes; a restart loop that just goes on is repeated every half hour.

## Restart loops

A container is in a restart loop when it has a restart policy (`always`, `unless-stopped`, `on-failure`) and keeps exiting. Pierside tells two kinds apart, because the fix differs:

- **It keeps crashing** (exit code other than 0): something is wrong in the container. The message gives the exit code; look at its logs.
- **Its command keeps finishing** (exit code 0): the container does its job, ends, and Docker starts it again. If it is meant to run once, change its restart policy to `no` or `on-failure`.

Stopping, restarting or killing a container yourself is never counted, whether you do it in Pierside, with `docker`, or with Compose: Docker marks those differently from a container that exits by itself. Docker waits longer before each new attempt, up to a minute, which is why the window is five minutes.

On the Containers page, a container that is restarting or unhealthy also shows in the sidebar's red badge.

## Swarm services

A failing Swarm task is replaced by a new one each time, possibly on another node, so Pierside looks at the service's tasks instead of at single containers, twice a minute. It reports a service when the same task slot (for a global service: the same node) failed or was rejected three times within five minutes, and gives Swarm's reason, for example a non-zero exit code or an image that can't be found. Several replicas of a service each finishing once is not reported. This needs the active engine to be a Swarm manager.

## Desktop notifications

Click the version number in the bottom bar and switch on **Desktop notifications for container problems**. Pierside then also shows a notification of your operating system for each alert. Switching it on shows a sample, so you can see that it works on your computer.

- **In Rancher Desktop** the notification is shown by Rancher Desktop itself. Its title is always "Warning" or "Error"; the text starts with "Pierside" and says what happened and on which engine. Clicking it does nothing. It appears for every alert, also while you are looking at Pierside.
- **In the separate window** it is your browser's notification, which asks for permission once. Clicking it goes to the container's logs or the service. It appears only when the Pierside window isn't the one in front.

Notifications, like the alerts themselves, need Pierside to be open: in Rancher Desktop with the Pierside tab shown, or in the separate window. Nothing watches your containers while Pierside is closed. They cover the engine that is active; for the others, see **At a glance** on the Engines page ([Remote engines](remote-engines.md)).
