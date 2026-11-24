IMAGE ?= pierside/extension
TAG ?= dev
REF = $(IMAGE):$(TAG)
# Rancher names the compose project rd-extension-<sanitised image id>.
BACKEND_FILTER = label=com.docker.compose.service=pierside

.PHONY: build install uninstall reinstall dev logs test

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

# Every suite in dev/tests (see make.ps1's Test-All): the Python ones in the image, with the working copy's
# backend mounted and a fresh /data. SUITE=<part of a file name> runs only the matching ones.
test:
	printf 'FROM $(REF)\nRUN pip install -q httpx==0.28.1\n' | docker build -q -t $(IMAGE):test - >/dev/null
	@failed=""; for f in $$(cd dev/tests && ls test_*.py test_*.mjs | grep -- "$(SUITE)"); do \
	  echo "==== $$f"; \
	  case $$f in \
	    *.mjs) node dev/tests/$$f ;; \
	    *) docker run --rm --entrypoint python -v "$(CURDIR)/backend/app:/src/app:ro" -v "$(CURDIR)/backend/app:/src/backend/app:ro" \
	         -v "$(CURDIR)/dev/tests:/t:ro" -v /var/run/docker.sock:/var/run/docker.sock --tmpfs /data -w /src $(IMAGE):test /t/$$f ;; \
	  esac || failed="$$failed $$f"; \
	done; \
	if [ -n "$$failed" ]; then echo "FAILED:$$failed"; exit 1; fi; echo "ALL SUITES PASS"

logs:
	docker logs -f --tail 200 $$(docker ps -q --filter $(BACKEND_FILTER) --filter label=com.docker.compose.project | head -n1)
