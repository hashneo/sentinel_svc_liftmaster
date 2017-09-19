env.ARCH = 'x86_64'
env.BUILD = '0.1.' + env.BUILD_NUMBER
env.LATEST = 'latest'
env.DOCKER_REGISTRY = 'docker.steventaylor.me'
env.SERVICE_NAME = 'sentinel-liftmaster'
env.CONTAINER1 = env.SERVICE_NAME + '-' + env.ARCH
env.DOCKER_HOST = 'tcp://build-' + env.ARCH + '.steventaylor.me:2375'
env.CONSUL = 'consul.steventaylor.me'

node {

  withCredentials([[$class: 'UsernamePasswordMultiBinding', credentialsId: 'registry',
                    usernameVariable: 'dockeruser', passwordVariable: 'dockerpass']]) {
        stage 'build'
        checkout scm

        sh 'docker login -u ${dockeruser} -p ${dockerpass} ${DOCKER_REGISTRY}'
        sh 'docker build -t ${DOCKER_REGISTRY}/${CONTAINER1}:${LATEST} -t ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD} -f Dockerfile.${ARCH} .'

        stage 'push'
        sh 'docker push ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'
        sh 'docker push ${DOCKER_REGISTRY}/${CONTAINER1}:${LATEST}'

        stage 'cleanup'
        sh 'docker rmi ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'
    }
}
