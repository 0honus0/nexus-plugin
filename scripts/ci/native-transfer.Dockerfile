ARG HOST_IMAGE
FROM ${HOST_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssh-client rsync zip unzip bzip2 && rm -rf /var/lib/apt/lists/*
