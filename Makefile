IMAGE ?= opencode-cli
TAG ?= dev
IMAGE_REF := $(IMAGE):$(TAG)
DOCKERFILE ?= Dockerfile
CONTEXT ?= .
OPENCODE_VERSION ?= latest

.PHONY: build clean

build:
	docker build \
		-t $(IMAGE_REF) \
		-f $(DOCKERFILE) \
		--build-arg OPENCODE_VERSION=$(OPENCODE_VERSION) \
		$(CONTEXT)

clean:
	@echo "Removing image $(IMAGE_REF) if it exists..."
	- docker image inspect $(IMAGE_REF) >/dev/null 2>&1 && docker rmi $(IMAGE_REF) || true
