IMAGE ?= pierside/extension
TAG ?= dev
REF = $(IMAGE):$(TAG)
# Rancher names the compose project rd-extension-<sanitised image id>.
BACKEND_FILTER = label=com.docker.compose.service=pierside

.PHONY: build install uninstall reinstall dev logs

build:
	docker build -t $(REF) .

install: build
	rdctl extension install $(REF)

uninstall:
	-rdctl extension uninstall $(REF)

# Rancher treats an install of an already-installed tag as a no-op, so uninstall first.
reinstall: build uninstall
	rdctl extension install $(REF)

# The backend's TCP port is picked by Docker; hand it and the session token to the dev UI.
dev:
	id=$$(docker ps -q --filter label=com.pierside.backend=true | head -n1); \
	cd ui && VITE_PIERSIDE_BACKEND=http://localhost:$$(docker port $$id 8080/tcp | head -n1 | sed 's/.*://') \
	VITE_PIERSIDE_TOKEN=$$(docker exec $$id cat /run/pierside-token) npm run dev

logs:
	docker logs -f --tail 200 $$(docker ps -q --filter $(BACKEND_FILTER) --filter label=com.docker.compose.project | head -n1)
