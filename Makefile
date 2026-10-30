IMAGE ?= opencode-cli
TAG ?= local
IMAGE_REF := $(IMAGE):$(TAG)
DOCKERFILE ?= Dockerfile
CONTEXT ?= .
DOCKER_BUILD_ARGS ?=
OPENCODE_VERSION ?= latest
AZURE_FOUNDRY_PROVIDER_REF ?= latest

.PHONY: build clean

build:
	docker build \
	  --progress=plain \
		-t $(IMAGE_REF) \
		-f $(DOCKERFILE) \
		--build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) \
		--build-arg AZURE_FOUNDRY_PROVIDER_REF=$(AZURE_FOUNDRY_PROVIDER_REF) \
		$(DOCKER_BUILD_ARGS) \
		$(CONTEXT)

run:
	@- docker run \
		--rm \
		-ti \
		--entrypoint bash \
		$(IMAGE_REF)

clean:
	@echo "Removing image $(IMAGE_REF) if it exists..."
	- docker image inspect $(IMAGE_REF) >/dev/null 2>&1 && docker rmi $(IMAGE_REF) || true
