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

# The backend's TCP port is picked by Docker; hand it to the dev UI.
dev:
	cd ui && VITE_PIERSIDE_BACKEND=http://localhost:$$(docker port $$(docker ps -q --filter label=com.pierside.backend=true | head -n1) 8080/tcp | head -n1 | sed 's/.*://') npm run dev

logs:
	docker logs -f --tail 200 $$(docker ps -q --filter $(BACKEND_FILTER) --filter label=com.docker.compose.project | head -n1)
