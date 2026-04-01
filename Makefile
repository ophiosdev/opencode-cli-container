IMAGE ?= opencode-cli
TAG ?= local
IMAGE_REF := $(IMAGE):$(TAG)
DOCKERFILE ?= Dockerfile
CONTEXT ?= .
OPENCODE_VERSION ?= latest
AZURE_FOUNDRY_PROVIDER_REF ?= v0.3.0

.PHONY: build clean

build:
	docker build \
	  --progress=plain \
		-t $(IMAGE_REF) \
		-f $(DOCKERFILE) \
		--build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) \
		--build-arg AZURE_FOUNDRY_PROVIDER_REF=$(AZURE_FOUNDRY_PROVIDER_REF) \
		$(CONTEXT)

clean:
	@echo "Removing image $(IMAGE_REF) if it exists..."
	- docker image inspect $(IMAGE_REF) >/dev/null 2>&1 && docker rmi $(IMAGE_REF) || true
