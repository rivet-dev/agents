# The sandbox image: Node.js, curl, and git from node:22, plus Python with pip and numpy.
FROM node:22
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3-pip \
	&& rm -rf /var/lib/apt/lists/*
# Debian marks its Python as externally managed. Let pip install into it so the agent can add packages.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 PIP_ROOT_USER_ACTION=ignore
RUN pip install --no-cache-dir numpy
